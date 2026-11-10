// Logjika qendrore e porosive dhe pagesave. Përdoret njësoj nga REST API-ja (online) dhe nga sinkronizimi (offline).
// Çdo funksion është idempotent: ID-të gjenerohen nga terminali, kështu që përsëritja e të njëjtit veprim
// kthen rezultatin ekzistues në vend që të krijojë dyfish.
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { FRONT, MANAGEMENT, hasRole, requireScope, type Principal } from '../auth/access.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { fromCents, toCents, vatFromGross } from '../lib/money.js';
import type { Outbox } from '../realtime/events.js';
import { audit, raiseAlert } from './audit.js';
import type * as S from './schemas.js';
import { createApproval, findApproved } from './approvals.js';

export interface Ctx { c: PoolClient; p: Principal; out: Outbox; offline?: boolean; ip?: string; system?: boolean }

type Order = Record<string, any>;

async function lockOrder(ctx: Ctx, orderId: string): Promise<Order> {
  const r = await ctx.c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!r.rows[0]) throw notFound('Porosia');
  const o = r.rows[0];
  if (!ctx.system) await requireScope(ctx.c, ctx.p, FRONT.concat(['driver', 'kitchen']), o.business_id, o.branch_id);
  return o;
}

async function branchInfo(ctx: Ctx, branchId: string) {
  const r = await ctx.c.query(
    `SELECT br.id, br.business_id, br.timezone, b.approval_rules, b.org_id
       FROM branches br JOIN businesses b ON b.id = br.business_id WHERE br.id=$1`, [branchId]);
  if (!r.rows[0] || r.rows[0].org_id !== ctx.p.orgId) throw notFound('Pika');
  return r.rows[0] as { id: string; business_id: string; timezone: string; approval_rules: any };
}

async function validShift(ctx: Ctx, shiftId: string | undefined, branchId: string) {
  if (!shiftId) return null;
  const r = await ctx.c.query('SELECT id, status FROM shifts WHERE id=$1 AND branch_id=$2', [shiftId, branchId]);
  if (!r.rows[0]) throw badRequest('invalid_shift', 'Turni nuk ekziston në këtë pikë');
  // Offline turni mund të jetë mbyllur ndërkohë nga serveri; e pranojmë që shitja të mos humbasë.
  if (r.rows[0].status !== 'open' && !ctx.offline) throw conflict('shift_closed', 'Turni është i mbyllur');
  return shiftId;
}

function emitOrder(ctx: Ctx, type: string, o: Order, extra: Record<string, unknown> = {}) {
  ctx.out.push({ type, orgId: ctx.p.orgId, businessId: o.business_id, branchId: o.branch_id, data: { order: o, ...extra } });
}

async function insertItems(ctx: Ctx, o: Order, items: z.infer<typeof S.orderItemInput>[]) {
  const inserted: any[] = [];
  for (const it of items) {
    const pr = await ctx.c.query('SELECT * FROM products WHERE id=$1 AND business_id=$2', [it.productId, o.business_id]);
    const prod = pr.rows[0];
    if (!prod) throw badRequest('invalid_product', `Produkti ${it.productId} nuk ekziston në këtë biznes`);
    if (!prod.is_active && !ctx.offline) throw badRequest('inactive_product', `Produkti "${prod.name}" është çaktivizuar`);
    let unitPrice = Number(prod.price);
    if (ctx.offline && it.unitPrice !== undefined && toCents(it.unitPrice) !== toCents(prod.price)) {
      // Klientit iu tregua çmimi nga katalogu i ruajtur lokalisht; e respektojmë dhe njoftojmë.
      unitPrice = it.unitPrice;
      await raiseAlert(ctx.c, ctx.out, ctx.p, {
        businessId: o.business_id, branchId: o.branch_id, kind: 'offline_price_mismatch', severity: 'info',
        message: `Porosi offline me çmim të vjetër për "${prod.name}": ${fromCents(toCents(unitPrice))} në vend të ${prod.price}`,
        data: { orderId: o.id, productId: prod.id, offlinePrice: unitPrice, serverPrice: prod.price },
      });
    }
    const lineTotal = fromCents(Math.round(toCents(unitPrice) * it.qty));
    const r = await ctx.c.query(
      `INSERT INTO order_items(id,order_id,business_id,product_id,name,qty,unit_price,unit_cost,vat_rate,line_total,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [it.id, o.id, o.business_id, prod.id, prod.name, it.qty, unitPrice, prod.cost, prod.vat_rate, lineTotal, it.note ?? null]);
    if (r.rows[0]) inserted.push(r.rows[0]);
    else {
      const ex = await ctx.c.query('SELECT order_id FROM order_items WHERE id=$1', [it.id]);
      if (ex.rows[0]?.order_id !== o.id) throw conflict('item_id_conflict', 'ID e artikullit i përket një porosie tjetër');
    }
  }
  return inserted;
}

/** Rillogarit totalet. Zbritja shpërndahet proporcionalisht mbi linjat për TVSH-në. */
async function recompute(ctx: Ctx, orderId: string): Promise<Order> {
  const items = (await ctx.c.query(
    "SELECT line_total, vat_rate FROM order_items WHERE order_id=$1 AND kitchen_status <> 'voided'", [orderId])).rows;
  const o = (await ctx.c.query('SELECT discount_amount, paid_total FROM orders WHERE id=$1', [orderId])).rows[0];
  const gross = items.reduce((s, i) => s + toCents(i.line_total), 0);
  const discount = Math.min(toCents(o.discount_amount), gross);
  const factor = gross === 0 ? 0 : (gross - discount) / gross;
  const vat = items.reduce((s, i) => s + vatFromGross(Math.round(toCents(i.line_total) * factor), Number(i.vat_rate)), 0);
  const total = gross - discount;
  if (total < toCents(o.paid_total)) throw conflict('total_below_paid', 'Totali nuk mund të bjerë nën shumën e paguar');
  const r = await ctx.c.query(
    `UPDATE orders SET subtotal=$2, vat_total=$3, total=$4, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
    [orderId, fromCents(total - vat), fromCents(vat), fromCents(total)]);
  return r.rows[0];
}

export async function createOrder(ctx: Ctx, input: z.infer<typeof S.createOrderInput>) {
  const ex = await ctx.c.query('SELECT * FROM orders WHERE id=$1', [input.id]);
  if (ex.rows[0]) {
    if (ex.rows[0].branch_id !== input.branchId) throw conflict('order_id_conflict', 'ID e porosisë ekziston në një pikë tjetër');
    return { order: ex.rows[0], duplicate: true };
  }
  const br = await branchInfo(ctx, input.branchId);
  await requireScope(ctx.c, ctx.p, FRONT, br.business_id, br.id);
  const shiftId = await validShift(ctx, input.shiftId, br.id);
  const when = ctx.offline && input.clientCreatedAt ? input.clientCreatedAt : new Date().toISOString();
  const day = (await ctx.c.query('SELECT ($1::timestamptz AT TIME ZONE $2)::date AS d', [when, br.timezone])).rows[0].d;
  const num = (await ctx.c.query(
    `INSERT INTO branch_counters(branch_id, day, last_number) VALUES ($1,$2,1)
     ON CONFLICT (branch_id, day) DO UPDATE SET last_number = branch_counters.last_number + 1 RETURNING last_number`,
    [br.id, day])).rows[0].last_number;
  const ins = await ctx.c.query(
    `INSERT INTO orders(id,business_id,branch_id,device_id,user_id,shift_id,order_number,business_day,type,table_label,
       customer_name,customer_phone,delivery_address,delivery_status,note,created_offline,client_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [input.id, br.business_id, br.id, ctx.p.deviceId ?? null, ctx.p.userId, shiftId, num, day, input.type, input.tableLabel ?? null,
      input.customerName ?? null, input.customerPhone ?? null, input.deliveryAddress ?? null,
      input.type === 'delivery' ? 'pending' : null, input.note ?? null, !!ctx.offline, input.clientCreatedAt ?? null]);
  if (!ins.rows[0]) {
    // Dy kërkesa njëkohësisht me të njëjtën ID: fiton e para.
    return { order: (await ctx.c.query('SELECT * FROM orders WHERE id=$1', [input.id])).rows[0], duplicate: true };
  }
  const items = await insertItems(ctx, ins.rows[0], input.items);
  const order = await recompute(ctx, input.id);
  await audit(ctx.c, ctx.p, 'order.create', { businessId: br.business_id, branchId: br.id, entity: 'order', entityId: order.id, data: { offline: !!ctx.offline } });
  emitOrder(ctx, 'order.created', order, { items });
  if (items.length) ctx.out.push({ type: 'kitchen.items', orgId: ctx.p.orgId, businessId: order.business_id, branchId: order.branch_id, roles: ['kitchen', 'manager', 'admin', 'owner'], data: { orderId: order.id, orderNumber: order.order_number, tableLabel: order.table_label, items } });
  return { order: { ...order }, items, duplicate: false };
}

export async function addItems(ctx: Ctx, input: z.infer<typeof S.addItemsInput>) {
  const o = await lockOrder(ctx, input.orderId);
  if (o.status !== 'open') throw conflict('order_not_open', 'Porosia nuk është e hapur');
  const items = await insertItems(ctx, o, input.items);
  const order = items.length ? await recompute(ctx, o.id) : o;
  if (items.length) {
    emitOrder(ctx, 'order.updated', order, { addedItems: items });
    ctx.out.push({ type: 'kitchen.items', orgId: ctx.p.orgId, businessId: order.business_id, branchId: order.branch_id, roles: ['kitchen', 'manager', 'admin', 'owner'], data: { orderId: order.id, orderNumber: order.order_number, tableLabel: order.table_label, items } });
  }
  return { order, items, duplicate: items.length === 0 };
}

export async function addPayment(ctx: Ctx, input: z.infer<typeof S.paymentInput>) {
  const o = await lockOrder(ctx, input.orderId);
  // Kontrolli i dyfishimit bëhet pasi porosia është bllokuar, kështu dy kërkesa të njëjta serializohen.
  const ex = await ctx.c.query('SELECT * FROM payments WHERE id=$1', [input.id]);
  if (ex.rows[0]) {
    if (ex.rows[0].order_id !== o.id) throw conflict('payment_id_conflict', 'ID e pagesës i përket një porosie tjetër');
    return { payment: ex.rows[0], order: o, duplicate: true };
  }
  if (o.status !== 'open') throw conflict('order_not_open', 'Porosia nuk është e hapur për pagesë');
  if (input.method === 'driver_cash' && o.type !== 'delivery') throw badRequest('invalid_method', 'Arkëtimi nga shoferi vlen vetëm për delivery');
  const remaining = toCents(o.total) - toCents(o.paid_total);
  if (toCents(input.amount) > remaining) throw conflict('overpayment', `Shuma tejkalon detyrimin e mbetur (${fromCents(remaining)})`, { remaining: fromCents(remaining) });
  const shiftId = await validShift(ctx, input.shiftId ?? o.shift_id ?? undefined, o.branch_id);
  const pay = (await ctx.c.query(
    `INSERT INTO payments(id,order_id,business_id,branch_id,shift_id,user_id,method,amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.id, o.id, o.business_id, o.branch_id, shiftId, ctx.p.userId, input.method, input.amount])).rows[0];
  let order = (await ctx.c.query(
    'UPDATE orders SET paid_total = paid_total + $2, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *',
    [o.id, input.amount])).rows[0];
  if (toCents(order.paid_total) === toCents(order.total)) order = await finalizeOrder(ctx, order);
  await audit(ctx.c, ctx.p, 'payment.create', { businessId: o.business_id, branchId: o.branch_id, entity: 'payment', entityId: pay.id, data: { orderId: o.id, amount: pay.amount, method: pay.method } });
  ctx.out.push({ type: 'payment.created', orgId: ctx.p.orgId, businessId: o.business_id, branchId: o.branch_id, data: { payment: pay, order } });
  return { payment: pay, order, duplicate: false };
}

/** Mbyll porosinë: statusi, dokumenti fiskal në radhë dhe zbritja e stokut. */
async function finalizeOrder(ctx: Ctx, o: Order): Promise<Order> {
  const order = (await ctx.c.query(
    "UPDATE orders SET status='paid', closed_at=now(), updated_at=now(), version=version+1 WHERE id=$1 RETURNING *", [o.id])).rows[0];
  await ctx.c.query(
    `INSERT INTO fiscal_documents(business_id, order_id, status) VALUES ($1,$2,'pending') ON CONFLICT (order_id) DO NOTHING`,
    [o.business_id, o.id]);
  await moveStock(ctx, order, -1, 'sale');
  emitOrder(ctx, 'order.paid', order);
  return order;
}

async function moveStock(ctx: Ctx, o: Order, sign: 1 | -1, reason: string) {
  const items = (await ctx.c.query(
    `SELECT oi.product_id, sum(oi.qty) AS qty FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id=$1 AND p.track_stock AND oi.kitchen_status <> 'voided' GROUP BY oi.product_id`, [o.id])).rows;
  for (const it of items) {
    const delta = sign * Number(it.qty);
    await ctx.c.query(
      `INSERT INTO stock_movements(business_id,branch_id,product_id,qty_delta,reason,ref_id,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.business_id, o.branch_id, it.product_id, delta, reason, o.id, ctx.p.userId]);
    const lvl = (await ctx.c.query(
      `INSERT INTO inventory_levels(branch_id,product_id,business_id,qty) VALUES ($1,$2,$3,$4)
       ON CONFLICT (branch_id,product_id) DO UPDATE SET qty = inventory_levels.qty + EXCLUDED.qty RETURNING qty, min_qty`,
      [o.branch_id, it.product_id, o.business_id, delta])).rows[0];
    if (sign < 0 && Number(lvl.qty) <= Number(lvl.min_qty)) {
      await raiseAlert(ctx.c, ctx.out, ctx.p, { businessId: o.business_id, branchId: o.branch_id, kind: 'low_stock', severity: 'warning', message: `Stok i ulët (${lvl.qty})`, data: { productId: it.product_id, qty: lvl.qty } });
    }
  }
}

export async function cancelOrder(ctx: Ctx, input: z.infer<typeof S.cancelOrderInput>) {
  const o = await lockOrder(ctx, input.orderId);
  if (o.status === 'cancelled') return { order: o, duplicate: true };
  const paid = toCents(o.paid_total) > 0;
  if (paid && !ctx.system) {
    // Anulimi i një porosie të paguar kërkon miratimin e pronarit.
    const approved = await findApproved(ctx.c, 'cancel_paid_order', o.id);
    if (!approved) {
      const ap = await createApproval(ctx, { businessId: o.business_id, branchId: o.branch_id, kind: 'cancel_paid_order', entityId: o.id,
        payload: { orderId: o.id, orderNumber: o.order_number, total: o.total, reason: input.reason } });
      return { order: o, pendingApproval: ap, duplicate: false };
    }
  }
  if (!paid && !ctx.system && !hasRole(ctx.p, FRONT, o.business_id, o.branch_id)) throw forbidden();
  if (paid) {
    await ctx.c.query("UPDATE payments SET status='refunded' WHERE order_id=$1 AND status='captured'", [o.id]);
    if (o.status === 'paid') await moveStock(ctx, o, 1, 'cancellation');
  }
  const order = (await ctx.c.query(
    `UPDATE orders SET status='cancelled', paid_total=0, closed_at=now(), updated_at=now(), version=version+1,
       note = coalesce(note || E'\n', '') || $2 WHERE id=$1 RETURNING *`, [o.id, `Anuluar: ${input.reason}`])).rows[0];
  await ctx.c.query(`UPDATE fiscal_documents SET last_error = coalesce(last_error,'') || ' | kërkon faturë korrigjuese' WHERE order_id=$1 AND status='fiscalized'`, [o.id]);
  await audit(ctx.c, ctx.p, 'order.cancel', { businessId: o.business_id, branchId: o.branch_id, entity: 'order', entityId: o.id, data: { reason: input.reason, paid } });
  await raiseAlert(ctx.c, ctx.out, ctx.p, {
    businessId: o.business_id, branchId: o.branch_id, kind: 'order_cancelled', severity: paid ? 'critical' : 'warning',
    message: `Porosia #${o.order_number} (${o.total} L) u anulua: ${input.reason}`, data: { orderId: o.id, userId: ctx.p.userId },
  });
  emitOrder(ctx, 'order.cancelled', order);
  return { order, duplicate: false };
}

export async function applyDiscount(ctx: Ctx, input: z.infer<typeof S.discountInput>) {
  const o = await lockOrder(ctx, input.orderId);
  if (o.status !== 'open') throw conflict('order_not_open', 'Porosia nuk është e hapur');
  const gross = (await ctx.c.query("SELECT coalesce(sum(line_total),0) AS g FROM order_items WHERE order_id=$1 AND kitchen_status <> 'voided'", [o.id])).rows[0].g;
  const pct = toCents(gross) === 0 ? 0 : (toCents(input.amount) / toCents(gross)) * 100;
  const rules = (await ctx.c.query('SELECT approval_rules FROM businesses WHERE id=$1', [o.business_id])).rows[0].approval_rules;
  const isOwner = hasRole(ctx.p, ['owner'], o.business_id, o.branch_id);
  if (!ctx.system && !isOwner && pct > Number(rules.discountPercentMax ?? 10)) {
    const approved = await findApproved(ctx.c, 'discount', o.id, { amount: fromCents(toCents(input.amount)) });
    if (!approved) {
      const ap = await createApproval(ctx, { businessId: o.business_id, branchId: o.branch_id, kind: 'discount', entityId: o.id,
        payload: { orderId: o.id, orderNumber: o.order_number, amount: fromCents(toCents(input.amount)), percent: Math.round(pct * 10) / 10, reason: input.reason ?? null } });
      return { order: o, pendingApproval: ap };
    }
  }
  if (!ctx.system && !hasRole(ctx.p, MANAGEMENT.concat(['cashier']), o.business_id, o.branch_id)) throw forbidden();
  await ctx.c.query('UPDATE orders SET discount_amount=$2 WHERE id=$1', [o.id, input.amount]);
  const order = await recompute(ctx, o.id);
  await audit(ctx.c, ctx.p, 'order.discount', { businessId: o.business_id, branchId: o.branch_id, entity: 'order', entityId: o.id, data: { amount: input.amount, percent: pct } });
  emitOrder(ctx, 'order.updated', order);
  return { order };
}

export async function assignDriver(ctx: Ctx, input: z.infer<typeof S.assignDriverInput>) {
  const o = await lockOrder(ctx, input.orderId);
  if (o.type !== 'delivery') throw badRequest('not_delivery', 'Porosia nuk është delivery');
  const d = await ctx.c.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='driver' AND (business_id IS NULL OR business_id=$2)", [input.driverId, o.business_id]);
  if (!d.rows[0]) throw badRequest('not_driver', 'Përdoruesi nuk është shofer i këtij biznesi');
  const order = (await ctx.c.query("UPDATE orders SET driver_id=$2, delivery_status='assigned', updated_at=now(), version=version+1 WHERE id=$1 RETURNING *", [o.id, input.driverId])).rows[0];
  emitOrder(ctx, 'delivery.updated', order);
  return { order };
}

export async function setDeliveryStatus(ctx: Ctx, input: z.infer<typeof S.deliveryStatusInput>) {
  const o = await lockOrder(ctx, input.orderId);
  if (o.type !== 'delivery') throw badRequest('not_delivery', 'Porosia nuk është delivery');
  const isDriver = o.driver_id === ctx.p.userId;
  if (!isDriver && !hasRole(ctx.p, MANAGEMENT.concat(['cashier']), o.business_id, o.branch_id)) throw forbidden();
  const order = (await ctx.c.query('UPDATE orders SET delivery_status=$2, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *', [o.id, input.status])).rows[0];
  if (input.status === 'failed') {
    await raiseAlert(ctx.c, ctx.out, ctx.p, { businessId: o.business_id, branchId: o.branch_id, kind: 'delivery_failed', message: `Delivery #${o.order_number} dështoi`, data: { orderId: o.id } });
  }
  emitOrder(ctx, 'delivery.updated', order);
  return { order };
}

export async function setKitchenStatus(ctx: Ctx, input: z.infer<typeof S.kitchenStatusInput>) {
  const it = (await ctx.c.query('SELECT order_id FROM order_items WHERE id=$1', [input.itemId])).rows[0];
  if (!it) throw notFound('Artikulli');
  const o = await lockOrder(ctx, it.order_id);
  const item = (await ctx.c.query('UPDATE order_items SET kitchen_status=$2 WHERE id=$1 RETURNING *', [input.itemId, input.status])).rows[0];
  ctx.out.push({ type: 'kitchen.status', orgId: ctx.p.orgId, businessId: o.business_id, branchId: o.branch_id, data: { orderId: o.id, item } });
  return { item };
}
