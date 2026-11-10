import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { MANAGEMENT, requireScope, visibleBusinesses } from '../auth/access.js';
import { verifyTotp } from '../auth/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { businessSummary, consolidated } from '../services/dashboard.js';
import { audit } from '../services/audit.js';
import * as orders from '../services/orders.js';
import { run } from './helpers.js';

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Tirane' });

export async function ownerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/v1/dashboard/consolidated', async (req) => {
    const q = z.object({ day: z.iso.date().optional() }).parse(req.query);
    const ids = await visibleBusinesses(pool, req.principal, ['owner', 'admin']);
    return consolidated(pool, ids, q.day ?? today());
  });

  app.get('/api/v1/dashboard/business/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ day: z.iso.date().optional(), branchId: z.uuid().optional() }).parse(req.query);
    await requireScope(pool, req.principal, MANAGEMENT, id, q.branchId);
    return businessSummary(pool, id, q.day ?? today(), q.branchId);
  });

  app.get('/api/v1/approvals', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).parse(req.query);
    const ids = await visibleBusinesses(pool, req.principal, ['owner']);
    const r = await pool.query(
      `SELECT a.*, u.full_name AS requested_by_name, b.name AS business_name FROM approval_requests a
         JOIN users u ON u.id=a.requested_by JOIN businesses b ON b.id=a.business_id
        WHERE a.business_id = ANY($1::uuid[]) AND a.status=$2 AND (a.status <> 'pending' OR a.expires_at > now())
        ORDER BY a.created_at DESC LIMIT 100`, [ids, q.status]);
    return { approvals: r.rows };
  });

  // Miratimi/refuzimi nga telefoni i pronarit. Kërkon kodin TOTP në çdo vendim (step-up authentication).
  app.post('/api/v1/approvals/:id/decide', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ decision: z.enum(['approve', 'reject']), totp: z.string().regex(/^\d{6}$/), note: z.string().max(500).optional() }).parse(req.body);
    const u = (await pool.query('SELECT totp_secret FROM users WHERE id=$1', [req.principal.userId])).rows[0];
    if (!u?.totp_secret) throw new AppError(403, 'totp_not_enabled', 'Aktivizoni 2FA para se të miratoni operacione');
    if (!verifyTotp(u.totp_secret, b.totp)) throw new AppError(401, 'totp_invalid', 'Kodi 2FA i gabuar');
    return run(req, async (ctx) => {
      const ap = (await ctx.c.query('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!ap) throw notFound('Kërkesa');
      await requireScope(ctx.c, ctx.p, ['owner'], ap.business_id);
      if (ap.status !== 'pending') throw conflict('already_decided', 'Kërkesa është vendosur tashmë');
      if (new Date(ap.expires_at) < new Date()) {
        await ctx.c.query("UPDATE approval_requests SET status='expired' WHERE id=$1", [id]);
        throw conflict('expired', 'Kërkesa ka skaduar');
      }
      const status = b.decision === 'approve' ? 'approved' : 'rejected';
      let effect: unknown = null;
      if (status === 'approved') {
        const sys = { ...ctx, system: true };
        if (ap.kind === 'cancel_paid_order') effect = await orders.cancelOrder(sys, { orderId: ap.entity_id, reason: `${ap.payload.reason} (miratuar nga pronari)` });
        else if (ap.kind === 'discount') effect = await orders.applyDiscount(sys, { orderId: ap.entity_id, amount: Number(ap.payload.amount), reason: ap.payload.reason });
      }
      const upd = (await ctx.c.query(
        `UPDATE approval_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4,
           payload = payload || jsonb_build_object('consumed', $2 = 'approved') WHERE id=$1 RETURNING *`,
        [id, status, ctx.p.userId, b.note ?? null])).rows[0];
      await audit(ctx.c, ctx.p, `approval.${status}`, { businessId: ap.business_id, branchId: ap.branch_id, entity: 'approval', entityId: id, data: { kind: ap.kind, note: b.note } });
      ctx.out.push({ type: 'approval.decided', orgId: ctx.p.orgId, businessId: ap.business_id, branchId: ap.branch_id, data: upd });
      return { approval: upd, effect };
    });
  });

  app.get('/api/v1/alerts', async (req) => {
    const q = z.object({ businessId: z.uuid(), open: z.coerce.boolean().default(true) }).parse(req.query);
    await requireScope(pool, req.principal, MANAGEMENT, q.businessId);
    const r = await pool.query(`SELECT * FROM alerts WHERE business_id=$1 AND (NOT $2 OR acknowledged_at IS NULL) ORDER BY created_at DESC LIMIT 200`, [q.businessId, q.open]);
    return { alerts: r.rows };
  });

  app.post('/api/v1/alerts/:id/ack', async (req) => {
    const { id } = req.params as { id: string };
    const a = (await pool.query('SELECT business_id FROM alerts WHERE id=$1', [id])).rows[0];
    if (!a) throw notFound('Alarmi');
    await requireScope(pool, req.principal, MANAGEMENT, a.business_id);
    await pool.query('UPDATE alerts SET acknowledged_by=$2, acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL', [id, req.principal.userId]);
    return { ok: true };
  });

  app.get('/api/v1/audit', async (req) => {
    const q = z.object({ businessId: z.uuid(), limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    await requireScope(pool, req.principal, ['owner', 'admin'], q.businessId);
    const r = await pool.query('SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.business_id=$1 ORDER BY at DESC LIMIT $2', [q.businessId, q.limit]);
    return { entries: r.rows };
  });
}
