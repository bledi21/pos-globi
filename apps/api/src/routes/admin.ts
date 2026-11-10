import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { MANAGEMENT, OWNERS, requireScope, visibleBusinesses } from '../auth/access.js';
import { hashSecret, randomToken, sha256 } from '../auth/crypto.js';
import { forbidden, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { run } from './helpers.js';

const roleEnum = z.enum(['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'warehouse', 'driver']);

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/v1/businesses', async (req) => {
    const ids = await visibleBusinesses(pool, req.principal, ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'warehouse', 'driver']);
    const branchScoped = req.principal.roles.filter((g) => g.businessId && g.branchId).map((g) => g.businessId!);
    const all = [...new Set([...ids, ...branchScoped])];
    const r = await pool.query(
      `SELECT b.id, b.name, b.legal_name, b.nipt, b.currency, b.vat_registered, b.default_vat_rate, b.approval_rules,
              coalesce(json_agg(json_build_object('id', br.id, 'name', br.name, 'address', br.address)) FILTER (WHERE br.id IS NOT NULL), '[]') AS branches
         FROM businesses b LEFT JOIN branches br ON br.business_id=b.id AND br.is_active
        WHERE b.id = ANY($1::uuid[]) GROUP BY b.id ORDER BY b.name`, [all]);
    return { businesses: r.rows };
  });

  app.post('/api/v1/businesses', async (req) => {
    const b = z.object({
      name: z.string().min(2), legalName: z.string().min(2), nipt: z.string().regex(/^[A-Z]\d{8}[A-Z]$/, 'NIPT i pavlefshëm'),
      vatRegistered: z.boolean().default(true), defaultVatRate: z.number().min(0).max(100).default(20),
    }).parse(req.body);
    if (!req.principal.roles.some((g) => g.role === 'owner' && g.businessId === null)) throw forbidden('Vetëm pronari krijon subjekte të reja');
    const r = await pool.query(
      `INSERT INTO businesses(org_id,name,legal_name,nipt,vat_registered,default_vat_rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.principal.orgId, b.name, b.legalName, b.nipt, b.vatRegistered, b.defaultVatRate]);
    await audit(pool, req.principal, 'business.create', { businessId: r.rows[0].id, data: b });
    return { business: r.rows[0] };
  });

  app.patch('/api/v1/businesses/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      approvalRules: z.object({ discountPercentMax: z.number().min(0).max(100), cashDifferenceMax: z.number().min(0) }).partial().optional(),
      fiscalConfig: z.record(z.string(), z.unknown()).optional(),
    }).parse(req.body);
    await requireScope(pool, req.principal, OWNERS, id);
    const r = await pool.query(
      `UPDATE businesses SET approval_rules = approval_rules || $2::jsonb, fiscal_config = fiscal_config || $3::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(b.approvalRules ?? {}), JSON.stringify(b.fiscalConfig ?? {})]);
    await audit(pool, req.principal, 'business.update', { businessId: id, data: b });
    return { business: r.rows[0] };
  });

  app.post('/api/v1/businesses/:id/branches', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(2), address: z.string().optional(), fiscalUnitCode: z.string().optional() }).parse(req.body);
    await requireScope(pool, req.principal, ['owner', 'admin'], id);
    const r = await pool.query('INSERT INTO branches(business_id,name,address,fiscal_unit_code) VALUES ($1,$2,$3,$4) RETURNING *', [id, b.name, b.address ?? null, b.fiscalUnitCode ?? null]);
    await audit(pool, req.principal, 'branch.create', { businessId: id, branchId: r.rows[0].id, data: b });
    return { branch: r.rows[0] };
  });

  // Regjistrimi i një terminali: token-i kthehet VETËM një herë dhe ruhet në pajisje.
  app.post('/api/v1/branches/:id/devices', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(2), kind: z.enum(['pos', 'kitchen', 'bar', 'warehouse', 'delivery', 'admin']).default('pos'), fiscalTcrCode: z.string().optional() }).parse(req.body);
    const br = (await pool.query('SELECT business_id FROM branches WHERE id=$1', [id])).rows[0];
    if (!br) throw notFound('Pika');
    await requireScope(pool, req.principal, ['owner', 'admin'], br.business_id, id);
    const token = randomToken(32);
    const r = await pool.query(
      'INSERT INTO devices(branch_id,business_id,name,kind,token_hash,fiscal_tcr_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, kind, branch_id, business_id',
      [id, br.business_id, b.name, b.kind, sha256(token), b.fiscalTcrCode ?? null]);
    await audit(pool, req.principal, 'device.create', { businessId: br.business_id, branchId: id, entity: 'device', entityId: r.rows[0].id });
    return { device: r.rows[0], deviceToken: token };
  });

  app.post('/api/v1/devices/:id/deactivate', async (req) => {
    const { id } = req.params as { id: string };
    const d = (await pool.query('SELECT business_id, branch_id FROM devices WHERE id=$1', [id])).rows[0];
    if (!d) throw notFound('Terminali');
    await requireScope(pool, req.principal, ['owner', 'admin'], d.business_id, d.branch_id);
    await pool.query('UPDATE devices SET is_active=false WHERE id=$1', [id]);
    await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [id]);
    await audit(pool, req.principal, 'device.deactivate', { businessId: d.business_id, branchId: d.branch_id, entity: 'device', entityId: id });
    return { ok: true };
  });

  app.post('/api/v1/users', async (req) => {
    const b = z.object({
      fullName: z.string().min(2), email: z.email().optional(), password: z.string().min(10).optional(), pin: z.string().regex(/^\d{4,6}$/).optional(),
      roles: z.array(z.object({ role: roleEnum, businessId: z.uuid().nullable().default(null), branchId: z.uuid().nullable().default(null) })).min(1),
    }).parse(req.body);
    // Kush krijon përdorues duhet të ketë autoritet mbi çdo rol që jep; vetëm pronari jep rolin owner/admin.
    for (const g of b.roles) {
      if ((g.role === 'owner' || g.role === 'admin' || g.businessId === null) && !req.principal.roles.some((x) => x.role === 'owner' && x.businessId === null)) throw forbidden('Vetëm pronari jep këtë rol');
      if (g.businessId) await requireScope(pool, req.principal, ['owner', 'admin', 'manager'], g.businessId, g.branchId);
      if (g.role === 'manager' && g.businessId && !req.principal.roles.some((x) => (x.role === 'owner' || x.role === 'admin') && (x.businessId === null || x.businessId === g.businessId))) throw forbidden('Vetëm pronari/admini cakton menaxherë');
    }
    const user = await run(req, async ({ c, p }) => {
      const u = (await c.query('INSERT INTO users(org_id,full_name,email,password_hash,pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, email',
        [p.orgId, b.fullName, b.email ?? null, b.password ? await hashSecret(b.password) : null, b.pin ? await hashSecret(b.pin) : null])).rows[0];
      for (const g of b.roles) await c.query('INSERT INTO user_roles(user_id,role,business_id,branch_id) VALUES ($1,$2,$3,$4)', [u.id, g.role, g.businessId, g.branchId]);
      await audit(c, p, 'user.create', { entity: 'user', entityId: u.id, data: { roles: b.roles } });
      return u;
    });
    return { user };
  });

  // ===== Katalogu =====
  app.get('/api/v1/businesses/:id/catalog', async (req) => {
    const { id } = req.params as { id: string };
    await requireScope(pool, req.principal, ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'warehouse', 'driver'], id, req.principal.roles.find((g) => g.businessId === id && g.branchId)?.branchId);
    const [cats, prods] = await Promise.all([
      pool.query('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order, name', [id]),
      pool.query('SELECT * FROM products WHERE business_id=$1 ORDER BY name', [id]),
    ]);
    return { categories: cats.rows, products: prods.rows };
  });

  app.post('/api/v1/businesses/:id/categories', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(1), sortOrder: z.number().int().default(0) }).parse(req.body);
    await requireScope(pool, req.principal, MANAGEMENT, id);
    const r = await pool.query('INSERT INTO product_categories(business_id,name,sort_order) VALUES ($1,$2,$3) RETURNING *', [id, b.name, b.sortOrder]);
    return { category: r.rows[0] };
  });

  const productBody = z.object({
    name: z.string().min(1), categoryId: z.uuid().nullable().optional(), sku: z.string().optional(),
    price: z.number().nonnegative(), cost: z.number().nonnegative().default(0), vatRate: z.number().min(0).max(100).default(20),
    unit: z.string().default('copë'), trackStock: z.boolean().default(false), isActive: z.boolean().default(true),
  });
  app.post('/api/v1/businesses/:id/products', async (req) => {
    const { id } = req.params as { id: string };
    const b = productBody.parse(req.body);
    await requireScope(pool, req.principal, MANAGEMENT, id);
    const r = await pool.query(
      `INSERT INTO products(business_id,category_id,name,sku,price,cost,vat_rate,unit,track_stock,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, b.categoryId ?? null, b.name, b.sku ?? null, b.price, b.cost, b.vatRate, b.unit, b.trackStock, b.isActive]);
    await audit(pool, req.principal, 'product.create', { businessId: id, entity: 'product', entityId: r.rows[0].id, data: b });
    return { product: r.rows[0] };
  });
  app.put('/api/v1/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = productBody.parse(req.body);
    const ex = (await pool.query('SELECT business_id, price FROM products WHERE id=$1', [id])).rows[0];
    if (!ex) throw notFound('Produkti');
    await requireScope(pool, req.principal, MANAGEMENT, ex.business_id);
    const r = await pool.query(
      `UPDATE products SET category_id=$2,name=$3,sku=$4,price=$5,cost=$6,vat_rate=$7,unit=$8,track_stock=$9,is_active=$10,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.categoryId ?? null, b.name, b.sku ?? null, b.price, b.cost, b.vatRate, b.unit, b.trackStock, b.isActive]);
    await audit(pool, req.principal, 'product.update', { businessId: ex.business_id, entity: 'product', entityId: id, data: { ...b, oldPrice: ex.price } });
    return { product: r.rows[0] };
  });

  // ===== Inventari =====
  app.post('/api/v1/branches/:id/stock', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ productId: z.uuid(), qtyDelta: z.number(), reason: z.enum(['purchase', 'waste', 'adjustment', 'transfer']), minQty: z.number().nonnegative().optional() }).parse(req.body);
    const br = (await pool.query('SELECT business_id FROM branches WHERE id=$1', [id])).rows[0];
    if (!br) throw notFound('Pika');
    const res = await run(req, async ({ c, p }) => {
      await requireScope(c, p, MANAGEMENT.concat(['warehouse']), br.business_id, id);
      const prod = (await c.query('SELECT 1 FROM products WHERE id=$1 AND business_id=$2', [b.productId, br.business_id])).rows[0];
      if (!prod) throw notFound('Produkti');
      await c.query('INSERT INTO stock_movements(business_id,branch_id,product_id,qty_delta,reason,user_id) VALUES ($1,$2,$3,$4,$5,$6)', [br.business_id, id, b.productId, b.qtyDelta, b.reason, p.userId]);
      const lvl = (await c.query(
        `INSERT INTO inventory_levels(branch_id,product_id,business_id,qty,min_qty) VALUES ($1,$2,$3,$4,coalesce($5,0))
         ON CONFLICT (branch_id,product_id) DO UPDATE SET qty=inventory_levels.qty+EXCLUDED.qty, min_qty=coalesce($5, inventory_levels.min_qty) RETURNING *`,
        [id, b.productId, br.business_id, b.qtyDelta, b.minQty ?? null])).rows[0];
      await audit(c, p, 'stock.move', { businessId: br.business_id, branchId: id, entity: 'product', entityId: b.productId, data: b });
      return lvl;
    });
    return { level: res };
  });

  app.get('/api/v1/branches/:id/stock', async (req) => {
    const { id } = req.params as { id: string };
    const br = (await pool.query('SELECT business_id FROM branches WHERE id=$1', [id])).rows[0];
    if (!br) throw notFound('Pika');
    await requireScope(pool, req.principal, MANAGEMENT.concat(['warehouse']), br.business_id, id);
    const r = await pool.query('SELECT i.*, p.name, p.unit FROM inventory_levels i JOIN products p ON p.id=i.product_id WHERE i.branch_id=$1 ORDER BY p.name', [id]);
    return { levels: r.rows };
  });
}
