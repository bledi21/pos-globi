import { randomUUID } from 'node:crypto';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://globi:globi@localhost:5432/globi_test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const { pool } = await import('../src/db.js');
const { redis, redisSub } = await import('../src/redis.js');
const { buildApp } = await import('../src/app.js');
const { seed } = await import('../src/seed.js');
const crypto = await import('../src/auth/crypto.js');

export { pool, redis, crypto };
export const uuid = () => randomUUID();

export async function setup() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  const s = (await seed(() => {}))!;
  const app = await buildApp({ logger: false });
  await app.ready();

  async function call(method: string, url: string, token?: string, body?: unknown) {
    const res = await app.inject({ method: method as any, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.json() as any };
  }
  const deviceLogin = async (deviceName: string, userId: string, pin: string) => {
    const r = await call('POST', '/api/v1/auth/device-login', undefined, { deviceToken: s.tokens[deviceName], userId, pin });
    if (r.status !== 200) throw new Error(`device login: ${JSON.stringify(r.body)}`);
    return r.body.accessToken as string;
  };
  const ownerLogin = async (totp?: string) => {
    const r = await call('POST', '/api/v1/auth/login', undefined, { email: 'pronari@globi.local', password: 'Ndrysho-Kete-2026!', totp });
    if (r.status !== 200) throw new Error(`owner login: ${JSON.stringify(r.body)}`);
    return r.body.accessToken as string;
  };
  const products = async (businessId: string) => (await pool.query('SELECT * FROM products WHERE business_id=$1 ORDER BY name', [businessId])).rows;
  return { app, s, call, deviceLogin, ownerLogin, products };
}

export async function teardown(app: { close(): Promise<void> }) {
  await app.close();
}
export async function closeAll() {
  await pool.end();
  redis.disconnect(); redisSub.disconnect();
}
