import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { AppError } from './lib/errors.js';
import { httpDuration, registry } from './lib/metrics.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { posRoutes } from './routes/pos.js';
import { ownerRoutes } from './routes/owner.js';
import { registerWs, startHub } from './realtime/hub.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'body.password', 'body.pin', 'body.totp', 'body.refreshToken', 'body.deviceToken'],
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', redis, nameSpace: 'globi:rl:' });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await authPlugin(app);

  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unknown', status: reply.statusCode }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation', message: z.prettifyError(err) });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === '23505') return reply.code(409).send({ error: 'duplicate', message: 'Regjistrimi ekziston tashmë' });
    if (e.code === '40P01' || e.code === '40001') return reply.code(503).send({ error: 'retry', message: 'Provoni përsëri' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'error', message: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Gabim i brendshëm i serverit' });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return { ok: true, db: 'ok', redis: 'ok' };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });
  // /metrics bllokohet nga Nginx për internetin; e lexon vetëm Prometheus në rrjetin e brendshëm.
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));

  // Në zhvillim API shërben edhe panelin e pronarit; në prodhim e shërben Nginx.
  if (process.env.OWNER_WEB_DIR) {
    const { readFile } = await import('node:fs/promises');
    const dir = process.env.OWNER_WEB_DIR;
    app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(`${dir}/index.html`)));
  }

  await authRoutes(app);
  await app.register(adminRoutes);
  await app.register(posRoutes);
  await app.register(ownerRoutes);
  await registerWs(app);
  await startHub();
  return app;
}
