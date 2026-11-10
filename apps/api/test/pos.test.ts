import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setup, teardown, closeAll, pool, uuid, crypto } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let cashier: string, waiter: string, owner: string;
const P = (n: string) => ctx.products(ctx.s.pizzeria).then((ps) => ps.find((p) => p.name === n)!);

before(async () => {
  ctx = await setup();
  cashier = await ctx.deviceLogin('Arka 1 Piceri', ctx.s.cashier, '1234');
  waiter = await ctx.deviceLogin('Arka 1 Bar', ctx.s.waiter, '2345');
  owner = await ctx.ownerLogin();
});
after(async () => { await teardown(ctx.app); await closeAll(); });

describe('autentikimi', () => {
  test('PIN i gabuar bllokohet pas 5 tentativave', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await ctx.call('POST', '/api/v1/auth/device-login', undefined, { deviceToken: ctx.s.tokens['Arka 1 Piceri'], userId: ctx.s.driver, pin: '0000' });
      assert.equal(r.status, 401);
    }
    const r = await ctx.call('POST', '/api/v1/auth/device-login', undefined, { deviceToken: ctx.s.tokens['Arka 1 Piceri'], userId: ctx.s.driver, pin: '3456' });
    assert.equal(r.status, 429);
  });
  test('punonjësi i barit nuk hyn në terminalin e picerisë', async () => {
    const r = await ctx.call('POST', '/api/v1/auth/device-login', undefined, { deviceToken: ctx.s.tokens['Arka 1 Piceri'], userId: ctx.s.waiter, pin: '2345' });
    assert.equal(r.status, 401);
  });
  test('refresh token rrotullohet dhe ripërdorimi anulon sesionet', async () => {
    const l = await ctx.call('POST', '/api/v1/auth/device-login', undefined, { deviceToken: ctx.s.tokens['Arka 1 Piceri'], userId: ctx.s.kitchen, pin: '4567' });
    const r1 = await ctx.call('POST', '/api/v1/auth/refresh', undefined, { refreshToken: l.body.refreshToken });
    assert.equal(r1.status, 200);
    const r2 = await ctx.call('POST', '/api/v1/auth/refresh', undefined, { refreshToken: l.body.refreshToken });
    assert.equal(r2.status, 401);
    const r3 = await ctx.call('POST', '/api/v1/auth/refresh', undefined, { refreshToken: r1.body.refreshToken });
    assert.equal(r3.status, 401, 'pas ripërdorimit, edhe token-i i ri anulohet');
  });
});

describe('porositë dhe pagesat', () => {
  test('rrjedha e plotë: turn, porosi, pagesë, fiskalizim, stok', async () => {
    const shiftId = uuid();
    assert.equal((await ctx.call('POST', '/api/v1/shifts', cashier, { id: shiftId, branchId: ctx.s.pizBranch, openingCash: 5000 })).status, 201);
    const marg = await P('Margarita'); const cola = await P('Coca-Cola 0.33');
    const orderId = uuid();
    const body = { id: orderId, branchId: ctx.s.pizBranch, shiftId, items: [{ id: uuid(), productId: marg.id, qty: 2 }, { id: uuid(), productId: cola.id, qty: 3 }] };
    const r = await ctx.call('POST', '/api/v1/orders', cashier, body);
    assert.equal(r.status, 201);
    assert.equal(r.body.order.total, '1800.00');
    assert.equal(r.body.order.vat_total, '300.00');
    // E njëjta kërkesë sërish (p.sh. timeout dhe riprovim) nuk krijon porosi të re
    const dup = await ctx.call('POST', '/api/v1/orders', cashier, body);
    assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);

    const over = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, cashier, { id: uuid(), method: 'cash', amount: 5000 });
    assert.equal(over.status, 409); assert.equal(over.body.error, 'overpayment');
    const payId = uuid();
    const p1 = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, cashier, { id: payId, method: 'cash', amount: 1800 });
    assert.equal(p1.status, 201); assert.equal(p1.body.order.status, 'paid');
    const p2 = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, cashier, { id: payId, method: 'cash', amount: 1800 });
    assert.equal(p2.status, 200); assert.equal(p2.body.duplicate, true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE order_id=$1', [orderId])).rows[0].n, 1);

    const stock = (await pool.query('SELECT qty FROM inventory_levels WHERE product_id=$1', [cola.id])).rows[0];
    assert.equal(Number(stock.qty), 45);

    const { processFiscalBatch } = await import('../src/services/fiscal/worker.js');
    const { MockFiscalProvider } = await import('../src/services/fiscal/provider.js');
    await processFiscalBatch(new MockFiscalProvider());
    const f = (await ctx.call('GET', `/api/v1/orders/${orderId}`, cashier)).body.fiscal;
    assert.equal(f.status, 'fiscalized'); assert.match(f.iic, /^[0-9A-F]{32}$/);

    const cash = await ctx.call('GET', `/api/v1/shifts/${shiftId}/cash`, cashier);
    assert.equal(cash.body.expected, '6800.00');
    const close = await ctx.call('POST', `/api/v1/shifts/${shiftId}/close`, cashier, { countedCash: 6000 });
    assert.equal(close.body.difference, '-800.00');
    const alert = (await pool.query("SELECT * FROM alerts WHERE kind='cash_difference'")).rows[0];
    assert.ok(alert, 'diferenca e arkës krijon alarm');
  });

  test('50 porosi njëkohësisht nga terminale të ndryshme marrin numra unikë', async () => {
    const marg = await P('Margarita');
    const res = await Promise.all(Array.from({ length: 50 }, () =>
      ctx.call('POST', '/api/v1/orders', cashier, { id: uuid(), branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] })));
    assert.ok(res.every((r) => r.status === 201), JSON.stringify(res.find((r) => r.status !== 201)?.body));
    const nums = new Set(res.map((r) => r.body.order.order_number));
    assert.equal(nums.size, 50);
  });

  test('pagesa paralele nuk e kalojnë totalin', async () => {
    const marg = await P('Margarita');
    const orderId = uuid();
    await ctx.call('POST', '/api/v1/orders', cashier, { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] });
    const res = await Promise.all(Array.from({ length: 10 }, () => ctx.call('POST', `/api/v1/orders/${orderId}/payments`, cashier, { id: uuid(), method: 'card', amount: 200 })));
    assert.equal(res.filter((r) => r.status === 201).length, 3);
    const o = (await pool.query('SELECT paid_total, total, status FROM orders WHERE id=$1', [orderId])).rows[0];
    assert.equal(o.paid_total, '600.00'); assert.equal(o.status, 'paid');
  });
});

describe('sinkronizimi offline', () => {
  test('i njëjti batch i dërguar disa herë, edhe paralelisht, aplikohet vetëm një herë', async () => {
    const marg = await P('Capricciosa');
    const shiftId = uuid(), orderId = uuid(), payId = uuid();
    const ops = [
      { opId: uuid(), type: 'shift.open', payload: { id: shiftId, branchId: ctx.s.pizBranch, openingCash: 0 } },
      { opId: uuid(), type: 'order.create', payload: { id: orderId, branchId: ctx.s.pizBranch, shiftId, clientCreatedAt: new Date().toISOString(), items: [{ id: uuid(), productId: marg.id, qty: 1, unitPrice: 800 }] } },
      { opId: uuid(), type: 'payment.create', payload: { id: payId, orderId, method: 'cash', amount: 800 } },
    ];
    const first = await ctx.call('POST', '/api/v1/sync/push', cashier, { ops });
    assert.deepEqual(first.body.results.map((r: any) => r.status), ['applied', 'applied', 'applied']);
    const again = await Promise.all(Array.from({ length: 5 }, () => ctx.call('POST', '/api/v1/sync/push', cashier, { ops })));
    for (const a of again) assert.deepEqual(a.body.results.map((r: any) => r.status), ['duplicate', 'duplicate', 'duplicate']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM orders WHERE id=$1', [orderId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE order_id=$1', [orderId])).rows[0].n, 1);
    const o = (await pool.query('SELECT status, created_offline FROM orders WHERE id=$1', [orderId])).rows[0];
    assert.equal(o.status, 'paid'); assert.equal(o.created_offline, true);
    await ctx.call('POST', `/api/v1/shifts/${shiftId}/close`, cashier, { countedCash: 800 });
  });

  test('paralelisht me op_id të rinj por të njëjtën pagesë: pagesa ruhet një herë', async () => {
    const marg = await P('Margarita');
    const orderId = uuid(), payId = uuid();
    await ctx.call('POST', '/api/v1/sync/push', cashier, { ops: [{ opId: uuid(), type: 'order.create', payload: { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] } }] });
    const res = await Promise.all(Array.from({ length: 6 }, () => ctx.call('POST', '/api/v1/sync/push', cashier,
      { ops: [{ opId: uuid(), type: 'payment.create', payload: { id: payId, orderId, method: 'cash', amount: 600 } }] })));
    assert.ok(res.every((r) => r.body.results[0].status === 'applied'));
    assert.equal(res.filter((r) => r.body.results[0].result.duplicate === false).length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE order_id=$1', [orderId])).rows[0].n, 1);
  });

  test('çmimi offline i vjetër respektohet dhe krijon alarm', async () => {
    const marg = await P('Margarita');
    const orderId = uuid();
    const r = await ctx.call('POST', '/api/v1/sync/push', cashier, { ops: [{ opId: uuid(), type: 'order.create', payload: { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1, unitPrice: 550 }] } }] });
    assert.equal(r.body.results[0].result.order.total, '550.00');
    assert.ok((await pool.query("SELECT 1 FROM alerts WHERE kind='offline_price_mismatch'")).rows[0]);
  });

  test('veprimet e palejuara offline refuzohen', async () => {
    const r = await ctx.call('POST', '/api/v1/sync/push', cashier, { ops: [{ opId: uuid(), type: 'order.cancel', payload: {} }] });
    assert.equal(r.status, 400);
  });
});

describe('ndarja e bizneseve', () => {
  test('kamarieri i barit nuk sheh as nuk paguan porosi të picerisë', async () => {
    const marg = await P('Margarita');
    const orderId = uuid();
    await ctx.call('POST', '/api/v1/orders', cashier, { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] });
    assert.equal((await ctx.call('GET', `/api/v1/orders/${orderId}`, waiter)).status, 403);
    assert.equal((await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, waiter, { id: uuid(), method: 'cash', amount: 600 })).status, 403);
    assert.equal((await ctx.call('POST', '/api/v1/orders', waiter, { id: uuid(), branchId: ctx.s.pizBranch, items: [] })).status, 403);
    assert.equal((await ctx.call('GET', `/api/v1/dashboard/business/${ctx.s.pizzeria}`, waiter)).status, 403);
  });
  test('produkti i një biznesi nuk përdoret në tjetrin', async () => {
    const marg = await P('Margarita');
    const r = await ctx.call('POST', '/api/v1/orders', waiter, { id: uuid(), branchId: ctx.s.barBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_product');
  });
  test('pamja e grupit tregon çdo subjekt veçmas', async () => {
    const r = await ctx.call('GET', '/api/v1/dashboard/consolidated', owner);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.businesses.map((b: any) => b.name), ['Bar Café GLOBI', 'Piceri GLOBI']);
    assert.ok(Number(r.body.businesses[1].turnover) > 0);
    assert.equal(Number(r.body.businesses[0].turnover), 0);
  });
});

describe('miratimet nga pronari', () => {
  test('anulimi i porosisë së paguar kërkon miratim me 2FA', async () => {
    const cola = await P('Coca-Cola 0.33');
    const orderId = uuid();
    await ctx.call('POST', '/api/v1/orders', cashier, { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: cola.id, qty: 2 }] });
    await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, cashier, { id: uuid(), method: 'cash', amount: 400 });
    const stockBefore = Number((await pool.query('SELECT qty FROM inventory_levels WHERE product_id=$1', [cola.id])).rows[0].qty);

    const c = await ctx.call('POST', `/api/v1/orders/${orderId}/cancel`, cashier, { reason: 'Klienti ndryshoi mendje' });
    assert.equal(c.status, 202);
    const apId = c.body.pendingApproval.id;
    const c2 = await ctx.call('POST', `/api/v1/orders/${orderId}/cancel`, cashier, { reason: 'Klienti ndryshoi mendje' });
    assert.equal(c2.body.pendingApproval.id, apId, 'nuk krijohet kërkesë e dyfishtë');

    const noTotp = await ctx.call('POST', `/api/v1/approvals/${apId}/decide`, owner, { decision: 'approve', totp: '123456' });
    assert.equal(noTotp.status, 403);
    const setup = await ctx.call('POST', '/api/v1/auth/totp/setup', owner);
    const code = () => crypto.totpAt(setup.body.secret, Math.floor(Date.now() / 30000));
    assert.equal((await ctx.call('POST', '/api/v1/auth/totp/enable', owner, { code: code() })).status, 200);
    // Kamarieri/arkëtari nuk mund të miratojë
    assert.equal((await ctx.call('POST', `/api/v1/approvals/${apId}/decide`, cashier, { decision: 'approve', totp: code() })).status, 403);

    const ok = await ctx.call('POST', `/api/v1/approvals/${apId}/decide`, owner, { decision: 'approve', totp: code() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.effect.order.status, 'cancelled');
    const pays = (await pool.query('SELECT status FROM payments WHERE order_id=$1', [orderId])).rows;
    assert.ok(pays.every((p) => p.status === 'refunded'));
    const stockAfter = Number((await pool.query('SELECT qty FROM inventory_levels WHERE product_id=$1', [cola.id])).rows[0].qty);
    assert.equal(stockAfter, stockBefore + 2);
    assert.equal((await ctx.call('POST', `/api/v1/approvals/${apId}/decide`, owner, { decision: 'approve', totp: code() })).status, 409);
    // Pas 2FA, hyrja me fjalëkalim kërkon kodin
    const l = await ctx.call('POST', '/api/v1/auth/login', undefined, { email: 'pronari@globi.local', password: 'Ndrysho-Kete-2026!' });
    assert.equal(l.body.error, 'totp_required');
  });

  test('zbritja mbi pragun kërkon miratim', async () => {
    const q = await P('Quattro Formaggi');
    const orderId = uuid();
    await ctx.call('POST', '/api/v1/orders', cashier, { id: orderId, branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: q.id, qty: 1 }] });
    const small = await ctx.call('POST', `/api/v1/orders/${orderId}/discount`, cashier, { amount: 50 });
    assert.equal(small.status, 200); assert.equal(small.body.order.total, '850.00');
    const big = await ctx.call('POST', `/api/v1/orders/${orderId}/discount`, cashier, { amount: 300 });
    assert.equal(big.status, 202);
  });
});

describe('panel i pronarit dhe kohë reale', () => {
  test('pronari merr porositë live; kamarieri i barit jo', async () => {
    const addr = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const url = addr.replace('http', 'ws') + '/api/v1/ws?token=';
    const open = (t: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
      const ws = new WebSocket(url + t); const msgs: any[] = [];
      ws.on('message', (m) => { const x = JSON.parse(m.toString()); if (x.type === 'hello') res({ ws, msgs }); else msgs.push(x); });
      ws.on('error', rej);
    });
    const freshOwner = await (async () => {
      const u = (await pool.query("SELECT totp_secret FROM users WHERE email='pronari@globi.local'")).rows[0];
      return ctx.ownerLogin(crypto.totpAt(u.totp_secret, Math.floor(Date.now() / 30000)));
    })();
    const o = await open(freshOwner); const w = await open(waiter);
    const marg = await P('Margarita');
    await ctx.call('POST', '/api/v1/orders', cashier, { id: uuid(), branchId: ctx.s.pizBranch, items: [{ id: uuid(), productId: marg.id, qty: 1 }] });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(o.msgs.some((m) => m.type === 'order.created'));
    assert.ok(!w.msgs.some((m) => m.type === 'order.created'));
    o.ws.close(); w.ws.close();

    const bad = new WebSocket(url + 'invalid');
    const code = await new Promise((r) => bad.on('close', (c) => r(c)));
    assert.equal(code, 4401);
  });

  test('përmbledhja e ditës për picerinë', async () => {
    const r = await ctx.call('GET', `/api/v1/dashboard/business/${ctx.s.pizzeria}`, owner);
    assert.equal(r.status, 200);
    assert.ok(Number(r.body.sales.turnover) > 0);
    assert.ok(r.body.salesByEmployee.length >= 1);
    assert.ok(r.body.alerts.length >= 1);
    assert.ok(Number(r.body.estimatedProfit) !== 0);
  });

  test('auditimi nuk mund të ndryshohet', async () => {
    await assert.rejects(pool.query('DELETE FROM audit_log'), /vetëm-shtim/);
  });
});
