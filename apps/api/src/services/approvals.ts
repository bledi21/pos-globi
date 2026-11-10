// Miratimet nga pronari: operacionet kritike krijojnë një kërkesë që pronari e miraton/refuzon nga telefoni (me TOTP).
import type { PoolClient } from 'pg';
import type { Ctx } from './orders.js';
import { audit } from './audit.js';

export async function createApproval(ctx: Ctx, a: { businessId: string; branchId?: string | null; kind: string; entityId?: string; payload: Record<string, unknown> }) {
  // Mos krijo kërkesa të dyfishta për të njëjtin veprim.
  const ex = await ctx.c.query(
    `SELECT * FROM approval_requests WHERE kind=$1 AND entity_id IS NOT DISTINCT FROM $2 AND status='pending' AND expires_at > now()`,
    [a.kind, a.entityId ?? null]);
  if (ex.rows[0]) return ex.rows[0];
  const r = await ctx.c.query(
    `INSERT INTO approval_requests(business_id,branch_id,kind,entity_id,payload,requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [a.businessId, a.branchId ?? null, a.kind, a.entityId ?? null, JSON.stringify(a.payload), ctx.p.userId]);
  await audit(ctx.c, ctx.p, 'approval.request', { businessId: a.businessId, branchId: a.branchId, entity: 'approval', entityId: r.rows[0].id, data: a.payload });
  ctx.out.push({ type: 'approval.requested', orgId: ctx.p.orgId, businessId: a.businessId, branchId: null, roles: ['owner'], data: r.rows[0] });
  return r.rows[0];
}

/** Gjen një miratim të pranuar dhe ende të papërdorur, dhe e shënon si të përdorur. */
export async function findApproved(c: PoolClient, kind: string, entityId: string, match?: Record<string, unknown>) {
  const r = await c.query(
    `SELECT * FROM approval_requests WHERE kind=$1 AND entity_id=$2 AND status='approved' AND NOT coalesce((payload->>'consumed')::boolean,false)
      ORDER BY decided_at DESC LIMIT 1 FOR UPDATE`, [kind, entityId]);
  const ap = r.rows[0];
  if (!ap) return null;
  if (match && Object.entries(match).some(([k, v]) => String(ap.payload[k]) !== String(v))) return null;
  await c.query(`UPDATE approval_requests SET payload = payload || '{"consumed":true}' WHERE id=$1`, [ap.id]);
  return ap;
}
