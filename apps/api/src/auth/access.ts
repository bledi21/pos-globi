import type { Db } from '../db.js';
import { forbidden, notFound } from '../lib/errors.js';

export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'waiter' | 'kitchen' | 'warehouse' | 'driver';
export interface RoleGrant { role: Role; businessId: string | null; branchId: string | null }
export interface Principal { userId: string; orgId: string; deviceId?: string; roles: RoleGrant[] }

export const MANAGEMENT: Role[] = ['owner', 'admin', 'manager'];
export const OWNERS: Role[] = ['owner'];
export const FRONT: Role[] = ['owner', 'admin', 'manager', 'cashier', 'waiter'];

export async function loadRoles(db: Db, userId: string): Promise<RoleGrant[]> {
  const r = await db.query(
    'SELECT role, business_id AS "businessId", branch_id AS "branchId" FROM user_roles WHERE user_id=$1', [userId]);
  return r.rows;
}

/** A ka përdoruesi një nga rolet në këtë biznes/pikë? Rolet në nivel organizate mbulojnë gjithçka. */
export function hasRole(p: Principal, roles: Role[], businessId: string, branchId?: string | null): boolean {
  return p.roles.some((g) =>
    roles.includes(g.role) &&
    (g.businessId === null || g.businessId === businessId) &&
    (g.branchId === null || (branchId != null && g.branchId === branchId)));
}

/** Verifikon që biznesi (dhe pika) i përkasin organizatës së përdoruesit dhe që ai ka rolin e duhur. */
export async function requireScope(db: Db, p: Principal, roles: Role[], businessId: string, branchId?: string | null) {
  const r = await db.query(
    `SELECT b.id, b.org_id, br.id AS branch_id FROM businesses b
       LEFT JOIN branches br ON br.business_id = b.id AND br.id = $2
      WHERE b.id = $1`, [businessId, branchId ?? null]);
  const row = r.rows[0];
  if (!row || row.org_id !== p.orgId) throw notFound('Biznesi');
  if (branchId && !row.branch_id) throw notFound('Pika');
  if (!hasRole(p, roles, businessId, branchId)) throw forbidden();
}

/** Bizneset që përdoruesi mund të shohë me një nga rolet. */
export async function visibleBusinesses(db: Db, p: Principal, roles: Role[]): Promise<string[]> {
  const r = await db.query('SELECT id FROM businesses WHERE org_id=$1 AND is_active ORDER BY name', [p.orgId]);
  return r.rows.map((x) => x.id).filter((id: string) =>
    p.roles.some((g) => roles.includes(g.role) && (g.businessId === null || g.businessId === id) && g.branchId === null));
}
