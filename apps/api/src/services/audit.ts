import type { Db } from '../db.js';
import type { Principal } from '../auth/access.js';
import type { Outbox } from '../realtime/events.js';

export async function audit(db: Db, p: Principal, action: string, o: { businessId?: string; branchId?: string | null; entity?: string; entityId?: string; data?: unknown; ip?: string }) {
  await db.query(
    `INSERT INTO audit_log(org_id,business_id,branch_id,user_id,device_id,action,entity,entity_id,data,ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [p.orgId, o.businessId ?? null, o.branchId ?? null, p.userId, p.deviceId ?? null, action, o.entity ?? null, o.entityId ?? null, JSON.stringify(o.data ?? {}), o.ip ?? null]);
}

export async function raiseAlert(db: Db, out: Outbox, p: Principal, a: { businessId: string; branchId?: string | null; kind: string; severity?: 'info' | 'warning' | 'critical'; message: string; data?: unknown }) {
  const r = await db.query(
    `INSERT INTO alerts(business_id,branch_id,kind,severity,message,data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [a.businessId, a.branchId ?? null, a.kind, a.severity ?? 'warning', a.message, JSON.stringify(a.data ?? {})]);
  out.push({ type: 'alert.created', orgId: p.orgId, businessId: a.businessId, branchId: a.branchId ?? null, roles: ['owner', 'admin', 'manager'], data: r.rows[0] });
  return r.rows[0];
}
