import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadRoles, type Principal } from './access.js';
import { pool } from '../db.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
  interface FastifyInstance { authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string; org: string; dev?: string; typ: 'access' } }
}

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('principal', null as unknown as Principal);
  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload;
    try { payload = await req.jwtVerify<{ sub: string; org: string; dev?: string; typ: string }>(); } catch { throw unauthorized(); }
    if (payload.typ !== 'access') throw unauthorized();
    const u = await pool.query('SELECT is_active FROM users WHERE id=$1', [payload.sub]);
    if (!u.rows[0]?.is_active) throw unauthorized('Llogaria është çaktivizuar');
    if (payload.dev) {
      const d = await pool.query('SELECT is_active FROM devices WHERE id=$1', [payload.dev]);
      if (!d.rows[0]?.is_active) throw unauthorized('Terminali është çaktivizuar');
    }
    req.principal = { userId: payload.sub, orgId: payload.org, deviceId: payload.dev, roles: await loadRoles(pool, payload.sub) };
  });
}
