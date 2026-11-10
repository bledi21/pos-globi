import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { FRONT, MANAGEMENT, requireScope } from '../auth/access.js';
import { notFound } from '../lib/errors.js';
import * as S from '../services/schemas.js';
import * as orders from '../services/orders.js';
import * as shifts from '../services/shifts.js';
import { pushOps, syncPushInput } from '../services/sync.js';
import { run } from './helpers.js';

export async function posRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ===== Porositë =====
  app.post('/api/v1/orders', async (req, reply) => {
    const input = S.createOrderInput.parse(req.body);
    const r = await run(req, (ctx) => orders.createOrder(ctx, input));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  app.post('/api/v1/orders/:id/items', async (req) => {
    const input = S.addItemsInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    return run(req, (ctx) => orders.addItems(ctx, input));
  });
  app.post('/api/v1/orders/:id/payments', async (req, reply) => {
    const input = S.paymentInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    const r = await run(req, (ctx) => orders.addPayment(ctx, input));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  app.post('/api/v1/orders/:id/cancel', async (req, reply) => {
    const input = S.cancelOrderInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    const r = await run(req, (ctx) => orders.cancelOrder(ctx, input));
    return reply.code('pendingApproval' in r && r.pendingApproval ? 202 : 200).send(r);
  });
  app.post('/api/v1/orders/:id/discount', async (req, reply) => {
    const input = S.discountInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    const r = await run(req, (ctx) => orders.applyDiscount(ctx, input));
    return reply.code('pendingApproval' in r && r.pendingApproval ? 202 : 200).send(r);
  });
  app.post('/api/v1/orders/:id/driver', async (req) => {
    const input = S.assignDriverInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    return run(req, (ctx) => orders.assignDriver(ctx, input));
  });
  app.post('/api/v1/orders/:id/delivery-status', async (req) => {
    const input = S.deliveryStatusInput.parse({ ...(req.body as object), orderId: (req.params as any).id });
    return run(req, (ctx) => orders.setDeliveryStatus(ctx, input));
  });
  app.post('/api/v1/kitchen/items/:id/status', async (req) => {
    const input = S.kitchenStatusInput.parse({ ...(req.body as object), itemId: (req.params as any).id });
    return run(req, (ctx) => orders.setKitchenStatus(ctx, input));
  });

  app.get('/api/v1/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    const o = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!o) throw notFound('Porosia');
    await requireScope(pool, req.principal, FRONT.concat(['kitchen', 'driver']), o.business_id, o.branch_id);
    const [items, payments, fiscal] = await Promise.all([
      pool.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY created_at', [id]),
      pool.query('SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at', [id]),
      pool.query('SELECT status, iic, fic, last_error FROM fiscal_documents WHERE order_id=$1', [id]),
    ]);
    return { order: o, items: items.rows, payments: payments.rows, fiscal: fiscal.rows[0] ?? null };
  });

  app.get('/api/v1/branches/:id/orders', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ status: z.enum(['open', 'paid', 'cancelled']).optional(), type: z.enum(['dine_in', 'takeaway', 'delivery']).optional() }).parse(req.query);
    const br = (await pool.query('SELECT business_id FROM branches WHERE id=$1', [id])).rows[0];
    if (!br) throw notFound('Pika');
    await requireScope(pool, req.principal, FRONT.concat(['kitchen', 'driver']), br.business_id, id);
    const r = await pool.query(
      `SELECT * FROM orders WHERE branch_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR type=$3)
        ORDER BY created_at DESC LIMIT 200`, [id, q.status ?? null, q.type ?? null]);
    return { orders: r.rows };
  });

  // ===== Turnet, shpenzimet, shoferët =====
  app.post('/api/v1/shifts', async (req, reply) => {
    const input = S.openShiftInput.parse(req.body);
    const r = await run(req, (ctx) => shifts.openShift(ctx, input));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  app.post('/api/v1/shifts/:id/close', async (req) => {
    const input = S.closeShiftInput.parse({ ...(req.body as object), shiftId: (req.params as any).id });
    return run(req, (ctx) => shifts.closeShift(ctx, input));
  });
  app.get('/api/v1/shifts/:id/cash', async (req) => {
    const { id } = req.params as { id: string };
    const s = (await pool.query('SELECT business_id, branch_id FROM shifts WHERE id=$1', [id])).rows[0];
    if (!s) throw notFound('Turni');
    await requireScope(pool, req.principal, MANAGEMENT.concat(['cashier']), s.business_id, s.branch_id);
    return run(req, (ctx) => shifts.expectedCash(ctx, id));
  });
  app.post('/api/v1/expenses', async (req, reply) => {
    const input = S.expenseInput.parse(req.body);
    const r = await run(req, (ctx) => shifts.createExpense(ctx, input));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  app.post('/api/v1/driver-settlements', async (req, reply) => {
    const input = S.driverSettlementInput.parse(req.body);
    const r = await run(req, (ctx) => shifts.settleDriver(ctx, input));
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  // ===== Sinkronizimi offline =====
  app.post('/api/v1/sync/push', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const input = syncPushInput.parse(req.body);
    return { results: await pushOps(req.principal, input) };
  });

  // Terminali tërheq katalogun dhe gjendjen për ta ruajtur lokalisht (për punë offline).
  app.get('/api/v1/sync/pull', async (req) => {
    const q = z.object({ since: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
    if (!req.principal.deviceId) throw notFound('Terminali');
    const d = (await pool.query('SELECT business_id, branch_id FROM devices WHERE id=$1', [req.principal.deviceId])).rows[0];
    await requireScope(pool, req.principal, FRONT.concat(['kitchen', 'driver', 'warehouse']), d.business_id, d.branch_id);
    const since = q.since ?? '1970-01-01T00:00:00Z';
    const serverTime = new Date().toISOString();
    const [cats, prods, open] = await Promise.all([
      pool.query('SELECT * FROM product_categories WHERE business_id=$1 AND updated_at > $2', [d.business_id, since]),
      pool.query('SELECT * FROM products WHERE business_id=$1 AND updated_at > $2', [d.business_id, since]),
      pool.query("SELECT * FROM orders WHERE branch_id=$1 AND status='open' ORDER BY created_at", [d.branch_id]),
    ]);
    return { serverTime, categories: cats.rows, products: prods.rows, openOrders: open.rows };
  });
}
