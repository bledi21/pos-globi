// Sinkronizimi offline → server.
// Terminali ruan veprimet në një "outbox" lokal (IndexedDB) kur s'ka internet. Kur lidhja rikthehet,
// i dërgon me radhë. Çdo veprim ka op_id unik: nëse serveri e ka parë më parë, kthen të njëjtin rezultat
// pa e ri-aplikuar. Bashkë me ID-të e porosive/pagesave të gjeneruara nga klienti, kjo garanton
// që asnjë porosi ose pagesë nuk dyfishohet, edhe kur rrjeti bie në mes të dërgimit.
import { z } from 'zod';
import { pool } from '../db.js';
import type { Principal } from '../auth/access.js';
import { AppError } from '../lib/errors.js';
import { syncOps } from '../lib/metrics.js';
import { Outbox } from '../realtime/events.js';
import * as S from './schemas.js';
import * as orders from './orders.js';
import * as shifts from './shifts.js';

// Veprimet e lejuara offline. Anulimet e porosive të paguara, rimbursimet dhe zbritjet e mëdha
// kërkojnë miratim online, prandaj nuk janë këtu.
const handlers = {
  'shift.open': [S.openShiftInput, shifts.openShift],
  'shift.close': [S.closeShiftInput, shifts.closeShift],
  'order.create': [S.createOrderInput, orders.createOrder],
  'order.addItems': [S.addItemsInput, orders.addItems],
  'payment.create': [S.paymentInput, orders.addPayment],
  'expense.create': [S.expenseInput, shifts.createExpense],
  'driver.settle': [S.driverSettlementInput, shifts.settleDriver],
} as const;

export const syncPushInput = z.object({
  ops: z.array(z.object({
    opId: z.uuid(),
    type: z.enum(Object.keys(handlers) as [keyof typeof handlers, ...(keyof typeof handlers)[]]),
    clientTs: z.iso.datetime({ offset: true }).optional(),
    payload: z.unknown(),
  })).min(1).max(500),
});

export interface OpResult { opId: string; status: 'applied' | 'duplicate' | 'rejected'; result?: unknown; error?: { code: string; message: string } }

export async function pushOps(p: Principal, input: z.infer<typeof syncPushInput>): Promise<OpResult[]> {
  if (!p.deviceId) throw new AppError(400, 'device_required', 'Sinkronizimi kërkon një terminal të regjistruar');
  const results: OpResult[] = [];
  for (const op of input.ops) {
    const res = await applyOne(p, op);
    syncOps.inc({ type: op.type, result: res.status });
    results.push(res);
  }
  await pool.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [p.deviceId]);
  return results;
}

async function applyOne(p: Principal, op: z.infer<typeof syncPushInput>['ops'][number]): Promise<OpResult> {
  const out = new Outbox();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Rezervo op_id brenda transaksionit. Një dërgim paralel me të njëjtin op_id pret këtu derisa i pari të përfundojë.
    const claim = await c.query(
      `INSERT INTO sync_ops(op_id, device_id, op_type, status, client_ts) VALUES ($1,$2,$3,'applied',$4)
       ON CONFLICT (op_id) DO NOTHING RETURNING op_id`, [op.opId, p.deviceId, op.type, op.clientTs ?? null]);
    if (!claim.rows[0]) {
      const prev = (await c.query('SELECT status, result, device_id FROM sync_ops WHERE op_id=$1', [op.opId])).rows[0];
      await c.query('ROLLBACK');
      if (prev.device_id !== p.deviceId) return { opId: op.opId, status: 'rejected', error: { code: 'op_id_conflict', message: 'op_id i përket një terminali tjetër' } };
      return prev.status === 'applied'
        ? { opId: op.opId, status: 'duplicate', result: prev.result }
        : { opId: op.opId, status: 'rejected', error: prev.result };
    }
    const [schema, fn] = handlers[op.type];
    const payload = (schema as z.ZodType).parse(op.payload);
    await c.query('SAVEPOINT op');
    try {
      const result = await (fn as (ctx: orders.Ctx, i: unknown) => Promise<unknown>)({ c, p, out, offline: true }, payload);
      await c.query('UPDATE sync_ops SET result=$2 WHERE op_id=$1', [op.opId, JSON.stringify(result)]);
      await c.query('COMMIT');
      await out.flush();
      return { opId: op.opId, status: 'applied', result };
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT op');
      const err = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'internal', message: 'Gabim i brendshëm' };
      if (!(e instanceof AppError)) console.error(e);
      // Gabimet e biznesit ruhen që përsëritja të marrë të njëjtën përgjigje; gabimet e brendshme jo, që të riprovohen.
      if (e instanceof AppError) {
        await c.query("UPDATE sync_ops SET status='rejected', result=$2 WHERE op_id=$1", [op.opId, JSON.stringify(err)]);
        await c.query('COMMIT');
      } else {
        await c.query('ROLLBACK');
      }
      return { opId: op.opId, status: 'rejected', error: err };
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e instanceof z.ZodError) return { opId: op.opId, status: 'rejected', error: { code: 'validation', message: z.prettifyError(e) } };
    throw e;
  } finally {
    c.release();
  }
}
