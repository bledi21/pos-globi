// Paneli i pronarit: të dhëna live për një biznes, dhe pamje e përgjithshme ku çdo subjekt raportohet veçmas.
import type { Db } from '../db.js';

export async function businessSummary(db: Db, businessId: string, day: string, branchId?: string | null) {
  const br = branchId ?? null;
  const q = (sql: string, extra: unknown[] = []) => db.query(sql, [businessId, day, br, ...extra]);
  const branchFilter = 'AND ($3::uuid IS NULL OR branch_id = $3)';
  // Dita e punës llogaritet sipas zonës kohore të pikës.
  const dayFilter = `AND (created_at AT TIME ZONE 'Europe/Tirane')::date = $2::date`;

  const [sales, byEmployee, delivery, drivers, shifts, expenses, cogs, alerts, approvals, lowStock, open, pay] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE status='paid')::int AS paid_orders,
              count(*) FILTER (WHERE status='open')::int AS open_orders,
              count(*) FILTER (WHERE status='cancelled')::int AS cancelled_orders,
              coalesce(sum(total) FILTER (WHERE status='paid'),0) AS turnover,
              coalesce(sum(vat_total) FILTER (WHERE status='paid'),0) AS vat,
              coalesce(sum(subtotal) FILTER (WHERE status='paid'),0) AS net,
              coalesce(sum(total) FILTER (WHERE status='open'),0) AS open_value,
              coalesce(sum(discount_amount) FILTER (WHERE status='paid'),0) AS discounts
         FROM orders WHERE business_id=$1 AND business_day=$2 ${branchFilter}`),
    q(`SELECT u.id AS user_id, u.full_name, count(*)::int AS orders, coalesce(sum(o.total),0) AS total
         FROM orders o JOIN users u ON u.id=o.user_id
        WHERE o.business_id=$1 AND o.business_day=$2 AND o.status='paid' AND ($3::uuid IS NULL OR o.branch_id=$3)
        GROUP BY u.id, u.full_name ORDER BY total DESC`),
    q(`SELECT o.id, o.order_number, o.status, o.delivery_status, o.total, o.paid_total, o.customer_name, o.delivery_address, u.full_name AS driver
         FROM orders o LEFT JOIN users u ON u.id=o.driver_id
        WHERE o.business_id=$1 AND o.business_day=$2 AND o.type='delivery' AND ($3::uuid IS NULL OR o.branch_id=$3)
        ORDER BY o.created_at DESC LIMIT 100`),
    q(`SELECT u.id AS driver_id, u.full_name,
              coalesce((SELECT sum(p.amount) FROM payments p JOIN orders o ON o.id=p.order_id
                 WHERE o.driver_id=u.id AND p.method='driver_cash' AND p.status='captured' AND o.business_id=$1 AND o.business_day=$2),0) AS collected,
              coalesce((SELECT sum(amount) FROM driver_settlements s WHERE s.driver_id=u.id AND s.business_id=$1 AND (s.created_at AT TIME ZONE 'Europe/Tirane')::date=$2::date),0) AS settled
         FROM users u WHERE EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role='driver' AND (r.business_id IS NULL OR r.business_id=$1))
           AND ($3::uuid IS NULL OR $3::uuid IS NOT NULL)`),
    q(`SELECT s.id, s.branch_id, u.full_name, s.opened_at, s.opening_cash,
              s.opening_cash
                + coalesce((SELECT sum(amount) FROM payments WHERE shift_id=s.id AND method='cash' AND status='captured'),0)
                + coalesce((SELECT sum(amount) FROM driver_settlements WHERE shift_id=s.id),0)
                - coalesce((SELECT sum(amount) FROM expenses WHERE shift_id=s.id AND paid_from_drawer),0) AS cash_in_drawer
         FROM shifts s JOIN users u ON u.id=s.user_id
        WHERE s.business_id=$1 AND s.status='open' AND ($3::uuid IS NULL OR s.branch_id=$3) AND $2::date IS NOT NULL
        ORDER BY s.opened_at`),
    q(`SELECT coalesce(sum(amount),0) AS total, count(*)::int AS count FROM expenses WHERE business_id=$1 ${dayFilter} ${branchFilter}`),
    q(`SELECT coalesce(sum(oi.unit_cost * oi.qty),0) AS cogs FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE o.business_id=$1 AND o.business_day=$2 AND o.status='paid' AND oi.kitchen_status <> 'voided' AND ($3::uuid IS NULL OR o.branch_id=$3)`),
    q(`SELECT * FROM alerts WHERE business_id=$1 AND acknowledged_at IS NULL AND $2::date IS NOT NULL ${branchFilter} ORDER BY created_at DESC LIMIT 50`),
    q(`SELECT * FROM approval_requests WHERE business_id=$1 AND status='pending' AND expires_at > now() AND $2::date IS NOT NULL ${branchFilter} ORDER BY created_at`),
    q(`SELECT i.product_id, p.name, i.qty, i.min_qty, i.branch_id FROM inventory_levels i JOIN products p ON p.id=i.product_id
        WHERE i.business_id=$1 AND i.qty <= i.min_qty AND $2::date IS NOT NULL AND ($3::uuid IS NULL OR i.branch_id=$3) ORDER BY i.qty LIMIT 50`),
    q(`SELECT id, order_number, type, table_label, total, paid_total, created_at, user_id FROM orders
        WHERE business_id=$1 AND status='open' AND $2::date IS NOT NULL ${branchFilter} ORDER BY created_at DESC LIMIT 50`),
    q(`SELECT method, coalesce(sum(p.amount),0) AS total FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE p.business_id=$1 AND o.business_day=$2 AND p.status='captured' AND ($3::uuid IS NULL OR p.branch_id=$3) GROUP BY method`),
  ]);
  const s = sales.rows[0];
  const exp = Number(expenses.rows[0].total);
  const est = Number(s.net) - Number(cogs.rows[0].cogs) - exp;
  return {
    businessId, day, branchId: br,
    sales: s,
    paymentsByMethod: pay.rows,
    salesByEmployee: byEmployee.rows,
    deliveries: delivery.rows,
    drivers: drivers.rows.map((d) => ({ ...d, outstanding: (Number(d.collected) - Number(d.settled)).toFixed(2) })),
    openShifts: shifts.rows,
    expenses: expenses.rows[0],
    costOfGoods: cogs.rows[0].cogs,
    // Fitimi i përllogaritur = shitjet neto (pa TVSH) − kosto e mallit − shpenzimet. Nuk zëvendëson bilancin kontabël.
    estimatedProfit: est.toFixed(2),
    openOrders: open.rows,
    lowStock: lowStock.rows,
    alerts: alerts.rows,
    pendingApprovals: approvals.rows,
  };
}

/** Pamja e grupit: një rresht për çdo subjekt ligjor, pa i bashkuar regjistrimet kontabël. */
export async function consolidated(db: Db, businessIds: string[], day: string) {
  if (!businessIds.length) return { day, businesses: [] };
  const r = await db.query(
    `SELECT b.id, b.name, b.nipt, b.currency,
            coalesce(sum(o.total) FILTER (WHERE o.status='paid'),0) AS turnover,
            count(o.*) FILTER (WHERE o.status='paid')::int AS paid_orders,
            count(o.*) FILTER (WHERE o.status='open')::int AS open_orders,
            count(o.*) FILTER (WHERE o.status='cancelled')::int AS cancelled_orders,
            (SELECT count(*)::int FROM alerts a WHERE a.business_id=b.id AND a.acknowledged_at IS NULL) AS open_alerts,
            (SELECT count(*)::int FROM approval_requests ap WHERE ap.business_id=b.id AND ap.status='pending' AND ap.expires_at>now()) AS pending_approvals,
            (SELECT count(*)::int FROM shifts s WHERE s.business_id=b.id AND s.status='open') AS staff_on_shift
       FROM businesses b LEFT JOIN orders o ON o.business_id=b.id AND o.business_day=$2
      WHERE b.id = ANY($1::uuid[]) GROUP BY b.id ORDER BY b.name`, [businessIds, day]);
  return { day, businesses: r.rows };
}
