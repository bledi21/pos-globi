import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { newTotpSecret, randomToken, sha256, verifySecret, verifyTotp } from '../auth/crypto.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { loadRoles } from '../auth/access.js';

const MAX_PIN_ATTEMPTS = 5;

export async function authRoutes(app: FastifyInstance) {
  async function issue(user: { id: string; org_id: string }, deviceId?: string) {
    const accessToken = app.jwt.sign({ sub: user.id, org: user.org_id, dev: deviceId, typ: 'access' }, { expiresIn: config.ACCESS_TOKEN_TTL });
    const refreshToken = randomToken(48);
    await pool.query(`INSERT INTO refresh_tokens(user_id, device_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [user.id, deviceId ?? null, sha256(refreshToken), String(config.REFRESH_TOKEN_DAYS)]);
    return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL };
  }

  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/v1/auth/login', strict, async (req) => {
    const body = z.object({ email: z.email(), password: z.string().min(1), totp: z.string().optional() }).parse(req.body);
    const u = (await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) AND is_active', [body.email])).rows[0];
    if (!u || !(await verifySecret(body.password, u.password_hash))) throw unauthorized('Email ose fjalëkalim i gabuar');
    if (u.totp_secret) {
      if (!body.totp) throw new AppError(401, 'totp_required', 'Kërkohet kodi 2FA');
      if (!verifyTotp(u.totp_secret, body.totp)) throw unauthorized('Kodi 2FA i gabuar');
    }
    await audit(pool, { userId: u.id, orgId: u.org_id, roles: [] }, 'auth.login', { ip: req.ip });
    return { ...(await issue(u)), user: { id: u.id, fullName: u.full_name, roles: await loadRoles(pool, u.id), totpEnabled: !!u.totp_secret } };
  });

  // Hyrja në terminal: token-i i pajisjes + PIN-i i punonjësit.
  app.post('/api/v1/auth/device-login', strict, async (req) => {
    const body = z.object({ deviceToken: z.string().min(20), userId: z.uuid(), pin: z.string().regex(/^\d{4,6}$/) }).parse(req.body);
    const d = (await pool.query('SELECT d.*, b.org_id FROM devices d JOIN businesses b ON b.id=d.business_id WHERE d.token_hash=$1 AND d.is_active', [sha256(body.deviceToken)])).rows[0];
    if (!d) throw unauthorized('Terminal i panjohur');
    const key = `globi:pin:${d.id}:${body.userId}`;
    const attempts = Number(await redis.get(key)) || 0;
    if (attempts >= MAX_PIN_ATTEMPTS) throw new AppError(429, 'pin_locked', 'Shumë tentativa. Provoni pas 15 minutash ose kontaktoni menaxherin.');
    const u = (await pool.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND is_active', [body.userId, d.org_id])).rows[0];
    const roles = u ? await loadRoles(pool, u.id) : [];
    const allowedHere = roles.some((g) => (g.businessId === null || g.businessId === d.business_id) && (g.branchId === null || g.branchId === d.branch_id));
    if (!u || !allowedHere || !(await verifySecret(body.pin, u.pin_hash))) {
      await redis.multi().incr(key).expire(key, 900).exec();
      throw unauthorized('PIN i gabuar');
    }
    await redis.del(key);
    await pool.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [d.id]);
    await audit(pool, { userId: u.id, orgId: u.org_id, deviceId: d.id, roles: [] }, 'auth.device_login', { businessId: d.business_id, branchId: d.branch_id, ip: req.ip });
    return { ...(await issue(u, d.id)), user: { id: u.id, fullName: u.full_name, roles }, device: { id: d.id, branchId: d.branch_id, businessId: d.business_id, name: d.name } };
  });

  // Lista e punonjësve për ekranin e hyrjes në terminal (vetëm emri, pa të dhëna sensitive).
  app.post('/api/v1/auth/device-staff', strict, async (req) => {
    const body = z.object({ deviceToken: z.string().min(20) }).parse(req.body);
    const d = (await pool.query('SELECT * FROM devices WHERE token_hash=$1 AND is_active', [sha256(body.deviceToken)])).rows[0];
    if (!d) throw unauthorized('Terminal i panjohur');
    const r = await pool.query(
      `SELECT DISTINCT u.id, u.full_name FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.is_active AND u.pin_hash IS NOT NULL AND (r.business_id IS NULL OR r.business_id=$1) AND (r.branch_id IS NULL OR r.branch_id=$2)
          AND u.org_id = (SELECT org_id FROM businesses WHERE id=$1) ORDER BY u.full_name`, [d.business_id, d.branch_id]);
    return { device: { id: d.id, name: d.name, branchId: d.branch_id, businessId: d.business_id }, staff: r.rows };
  });

  app.post('/api/v1/auth/refresh', strict, async (req) => {
    const body = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const t = (await pool.query('SELECT * FROM refresh_tokens WHERE token_hash=$1', [sha256(body.refreshToken)])).rows[0];
    if (!t) throw unauthorized();
    if (t.revoked_at) {
      // Token i përdorur dy herë = mundësi vjedhjeje: anulo të gjitha sesionet e përdoruesit.
      await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [t.user_id]);
      throw unauthorized('Sesioni u anulua për siguri');
    }
    if (new Date(t.expires_at) < new Date()) throw unauthorized('Sesioni ka skaduar');
    const upd = await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [t.id]);
    if (!upd.rows[0]) throw unauthorized();
    const u = (await pool.query('SELECT id, org_id, is_active FROM users WHERE id=$1', [t.user_id])).rows[0];
    if (!u?.is_active) throw unauthorized();
    return issue(u, t.device_id ?? undefined);
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const body = z.object({ refreshToken: z.string() }).parse(req.body);
    await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1', [sha256(body.refreshToken)]);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { preHandler: app.authenticate }, async (req) => {
    const u = (await pool.query('SELECT id, full_name, email, totp_secret IS NOT NULL AS totp_enabled FROM users WHERE id=$1', [req.principal.userId])).rows[0];
    return { user: u, roles: req.principal.roles, deviceId: req.principal.deviceId ?? null };
  });

  // Aktivizimi i 2FA (Google Authenticator, Authy, etj.) — i detyrueshëm për miratimet nga telefoni.
  app.post('/api/v1/auth/totp/setup', { preHandler: app.authenticate }, async (req) => {
    const secret = newTotpSecret();
    await redis.set(`globi:totp-setup:${req.principal.userId}`, secret, 'EX', 600);
    const u = (await pool.query('SELECT email FROM users WHERE id=$1', [req.principal.userId])).rows[0];
    return { secret, otpauthUrl: `otpauth://totp/GLOBI%20POS:${encodeURIComponent(u.email ?? req.principal.userId)}?secret=${secret}&issuer=GLOBI%20POS` };
  });
  app.post('/api/v1/auth/totp/enable', { preHandler: app.authenticate }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const secret = await redis.get(`globi:totp-setup:${req.principal.userId}`);
    if (!secret) throw badRequest('totp_setup_expired', 'Konfigurimi skadoi, filloni përsëri');
    if (!verifyTotp(secret, code)) throw badRequest('totp_invalid', 'Kodi i gabuar');
    await pool.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [req.principal.userId, secret]);
    await redis.del(`globi:totp-setup:${req.principal.userId}`);
    await audit(pool, req.principal, 'auth.totp_enabled', {});
    return { ok: true };
  });
}
