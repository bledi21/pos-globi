// WebSocket hub: çdo instancë e API-së dëgjon kanalin Redis dhe ua shpërndan ngjarjet klientëve të vet,
// duke filtruar sipas biznesit/pikës/rolit. Kështu API mund të shkallëzohet horizontalisht.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { redisSub } from '../redis.js';
import { EVENTS_CHANNEL, type RealtimeEvent } from './events.js';
import { hasRole, loadRoles, type Principal, type Role } from '../auth/access.js';
import { pool } from '../db.js';
import { wsConnections } from '../lib/metrics.js';

const ALL_ROLES: Role[] = ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'warehouse', 'driver'];
const clients = new Set<{ ws: WebSocket; p: Principal }>();
let subscribed = false;

export function deliver(e: RealtimeEvent) {
  const msg = JSON.stringify({ type: e.type, businessId: e.businessId, branchId: e.branchId ?? null, data: e.data, at: e.at });
  for (const c of clients) {
    if (c.p.orgId !== e.orgId) continue;
    if (!hasRole(c.p, e.roles ?? ALL_ROLES, e.businessId, e.branchId ?? null)) continue;
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}

export async function startHub() {
  if (subscribed) return;
  subscribed = true;
  await redisSub.subscribe(EVENTS_CHANNEL);
  redisSub.on('message', (_ch, raw) => {
    try { deliver(JSON.parse(raw)); } catch { /* ngjarje e dëmtuar, injorohet */ }
  });
}

export async function registerWs(app: FastifyInstance) {
  app.get('/api/v1/ws', { websocket: true }, async (socket, req) => {
    // Token-i jepet në query sepse shfletuesit nuk lejojnë header-a në WebSocket.
    const token = (req.query as Record<string, string>).token;
    let p: Principal;
    try {
      const payload = app.jwt.verify<{ sub: string; org: string; dev?: string; typ: string }>(token);
      if (payload.typ !== 'access') throw new Error();
      p = { userId: payload.sub, orgId: payload.org, deviceId: payload.dev, roles: await loadRoles(pool, payload.sub) };
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const entry = { ws: socket, p };
    clients.add(entry);
    wsConnections.inc();
    socket.send(JSON.stringify({ type: 'hello', userId: p.userId }));
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25000);
    socket.on('message', (m) => { if (m.toString() === 'ping') socket.send('{"type":"pong"}'); });
    socket.on('close', () => { clients.delete(entry); clearInterval(ping); wsConnections.dec(); });
  });
}
