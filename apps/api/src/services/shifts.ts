import type { z } from 'zod';
import { FRONT, MANAGEMENT, hasRole, requireScope } from '../auth/access.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { fromCents, toCents } from '../lib/money.js';
import { audit, raiseAlert } from './audit.js';
import type { Ctx } from './orders.js';
import type * as S from './schemas.js';

async function branchBusiness(ctx: Ctx, branchId: string) {
  const r = await ctx.c.query('SELECT business_id FROM branches WHERE id=$1', [branchId]);
  if (!r.rows[0]) throw notFound('Pika');
  return r.rows[0].business_id as string;
}

export async function openShift(ctx: Ctx, input: z.infer<typeof S.openShiftInput>) {
  const ex = await ctx.c.query('SELECT * FROM shifts WHERE id=$1', [input.id]);
  if (ex.rows[0]) return { shift: ex.rows[0], duplicate: true };
  const businessId = await branchBusiness(ctx, input.branchId);
  await requireScope(ctx.c, ctx.p, FRONT.concat(['driver']), businessId, input.branchId);
  const open = await ctx.c.query("SELECT id FROM shifts WHERE branch_id=$1 AND user_id=$2 AND status='open'", [input.branchId, ctx.p.userId]);
  if (open.rows[0]) throw conflict('shift_already_open', 'Keni tashmë një turn të hapur', { shiftId: open.rows[0].id });
  const shift = (await ctx.c.query(
    `INSERT INTO shifts(id,business_id,branch_id,device_id,user_id,opening_cash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.id, businessId, input.branchId, ctx.p.deviceId ?? null, ctx.p.userId, input.openingCash])).rows[0];
  await audit(ctx.c, ctx.p, 'shift.open', { businessId, branchId: input.branchId, entity: 'shift', entityId: shift.id });
  ctx.out.push({ type: 'shift.opened', orgId: ctx.p.orgId, businessId, branchId: input.branchId, data: { shift } });
  return { shift, duplicate: false };
}

export async function expectedCash(ctx: Ctx, shiftId: string) {
  const r = await ctx.c.query(
    `SELECT s.opening_cash,
       (SELECT coalesce(sum(amount),0) FROM payments WHERE shift_id=s.id AND method='cash' AND status='captured') AS cash_sales,
       (SELECT coalesce(sum(amount),0) FROM driver_settlements WHERE shift_id=s.id) AS driver_cash,
       (SELECT coalesce(sum(amount),0) FROM expenses WHERE shift_id=s.id AND paid_from_drawer) AS expenses
     FROM shifts s WHERE s.id=$1`, [shiftId]);
  const x = r.rows[0];
  const cents = toCents(x.opening_cash) + toCents(x.cash_sales) + toCents(x.driver_cash) - toCents(x.expenses);
  return { ...x, expected: fromCents(cents) };
}

export async function closeShift(ctx: Ctx, input: z.infer<typeof S.closeShiftInput>) {
  const s = (await ctx.c.query('SELECT * FROM shifts WHERE id=$1 FOR UPDATE', [input.shiftId])).rows[0];
  if (!s) throw notFound('Turni');
  await requireScope(ctx.c, ctx.p, FRONT.concat(['driver']), s.business_id, s.branch_id);
  if (s.status === 'closed') return { shift: s, duplicate: true };
  if (s.user_id !== ctx.p.userId && !hasRole(ctx.p, MANAGEMENT, s.business_id, s.branch_id)) throw forbidden('Vetëm pronari i turnit ose menaxheri e mbyll');
  const exp = await expectedCash(ctx, s.id);
  const diff = toCents(input.countedCash) - toCents(exp.expected);
  const shift = (await ctx.c.query(
    `UPDATE shifts SET status='closed', closed_at=now(), counted_cash=$2, expected_cash=$3 WHERE id=$1 RETURNING *`,
    [s.id, input.countedCash, exp.expected])).rows[0];
  const rules = (await ctx.c.query('SELECT approval_rules FROM businesses WHERE id=$1', [s.business_id])).rows[0].approval_rules;
  if (Math.abs(diff) > toCents(rules.cashDifferenceMax ?? 500)) {
    await raiseAlert(ctx.c, ctx.out, ctx.p, {
      businessId: s.business_id, branchId: s.branch_id, kind: 'cash_difference', severity: 'critical',
      message: `Diferencë arke ${fromCents(diff)} L në mbylljen e turnit`, data: { shiftId: s.id, expected: exp.expected, counted: input.countedCash },
    });
  }
  await audit(ctx.c, ctx.p, 'shift.close', { businessId: s.business_id, branchId: s.branch_id, entity: 'shift', entityId: s.id, data: { ...exp, counted: input.countedCash, diff: fromCents(diff) } });
  ctx.out.push({ type: 'shift.closed', orgId: ctx.p.orgId, businessId: s.business_id, branchId: s.branch_id, data: { shift, difference: fromCents(diff) } });
  return { shift, difference: fromCents(diff), duplicate: false };
}

export async function createExpense(ctx: Ctx, input: z.infer<typeof S.expenseInput>) {
  const ex = await ctx.c.query('SELECT * FROM expenses WHERE id=$1', [input.id]);
  if (ex.rows[0]) return { expense: ex.rows[0], duplicate: true };
  const businessId = await branchBusiness(ctx, input.branchId);
  await requireScope(ctx.c, ctx.p, MANAGEMENT.concat(['cashier']), businessId, input.branchId);
  if (input.shiftId) {
    const s = await ctx.c.query('SELECT 1 FROM shifts WHERE id=$1 AND branch_id=$2', [input.shiftId, input.branchId]);
    if (!s.rows[0]) throw badRequest('invalid_shift', 'Turni nuk i përket kësaj pike');
  }
  const expense = (await ctx.c.query(
    `INSERT INTO expenses(id,business_id,branch_id,shift_id,user_id,category,amount,paid_from_drawer,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.id, businessId, input.branchId, input.shiftId ?? null, ctx.p.userId, input.category, input.amount, input.paidFromDrawer, input.note ?? null])).rows[0];
  await audit(ctx.c, ctx.p, 'expense.create', { businessId, branchId: input.branchId, entity: 'expense', entityId: expense.id, data: { amount: expense.amount } });
  ctx.out.push({ type: 'expense.created', orgId: ctx.p.orgId, businessId, branchId: input.branchId, roles: ['owner', 'admin', 'manager'], data: { expense } });
  return { expense, duplicate: false };
}

export async function settleDriver(ctx: Ctx, input: z.infer<typeof S.driverSettlementInput>) {
  const ex = await ctx.c.query('SELECT * FROM driver_settlements WHERE id=$1', [input.id]);
  if (ex.rows[0]) return { settlement: ex.rows[0], duplicate: true };
  const businessId = await branchBusiness(ctx, input.branchId);
  await requireScope(ctx.c, ctx.p, MANAGEMENT.concat(['cashier']), businessId, input.branchId);
  const settlement = (await ctx.c.query(
    `INSERT INTO driver_settlements(id,business_id,branch_id,driver_id,shift_id,amount,received_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.id, businessId, input.branchId, input.driverId, input.shiftId ?? null, input.amount, ctx.p.userId])).rows[0];
  await audit(ctx.c, ctx.p, 'driver.settle', { businessId, branchId: input.branchId, entity: 'driver_settlement', entityId: settlement.id, data: { driverId: input.driverId, amount: input.amount } });
  ctx.out.push({ type: 'driver.settled', orgId: ctx.p.orgId, businessId, branchId: input.branchId, data: { settlement } });
  return { settlement, duplicate: false };
}
