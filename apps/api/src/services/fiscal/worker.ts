// Radha e fiskalizimit: përpunon dokumentet "pending"/"failed" me riprovim të shtyrë (backoff).
// Bllokimi në Redis siguron që vetëm një instancë e API-së e punon radhën njëkohësisht.
import { pool } from '../../db.js';
import { redis } from '../../redis.js';
import { config } from '../../config.js';
import { fiscalQueue } from '../../lib/metrics.js';
import { MockFiscalProvider, type FiscalProvider } from './provider.js';

export function providerFromConfig(): FiscalProvider | null {
  if (config.FISCAL_MODE === 'disabled') return null;
  if (config.FISCAL_MODE === 'mock') return new MockFiscalProvider();
  throw new Error('FISCAL_MODE test/production kërkon konfigurimin e certifikatës (shih docs/FISKALIZIMI.md)');
}

export async function processFiscalBatch(provider: FiscalProvider, limit = 20) {
  const docs = (await pool.query(
    `SELECT f.id, f.order_id, f.attempts, o.order_number, o.business_day, o.total, o.vat_total, o.created_offline, o.closed_at,
            b.nipt, b.vat_registered, br.fiscal_unit_code, d.fiscal_tcr_code
       FROM fiscal_documents f JOIN orders o ON o.id=f.order_id JOIN businesses b ON b.id=f.business_id
       JOIN branches br ON br.id=o.branch_id LEFT JOIN devices d ON d.id=o.device_id
      WHERE f.status IN ('pending','failed') AND f.attempts < 20
        AND (f.attempts = 0 OR f.updated_at <= now() - (least(power(2, f.attempts), 3600) || ' seconds')::interval)
      ORDER BY f.issued_at LIMIT $1`, [limit])).rows;
  let ok = 0;
  for (const d of docs) {
    const items = (await pool.query("SELECT name, qty, unit_price, vat_rate, line_total FROM order_items WHERE order_id=$1 AND kitchen_status <> 'voided'", [d.order_id])).rows;
    try {
      const r = await provider.fiscalize({
        orderId: d.order_id, nipt: d.nipt, businessUnitCode: d.fiscal_unit_code, tcrCode: d.fiscal_tcr_code,
        issuedAt: new Date(d.closed_at).toISOString(), invoiceNumber: `${d.order_number}/${new Date(d.business_day).getFullYear()}`,
        total: d.total, vatTotal: d.vat_total, offline: d.created_offline,
        items: items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unit_price, vatRate: i.vat_rate, lineTotal: i.line_total })),
      });
      await pool.query(`UPDATE fiscal_documents SET status='fiscalized', iic=$2, fic=$3, request_xml=$4, response_xml=$5, attempts=attempts+1, last_error=NULL, updated_at=now() WHERE id=$1`,
        [d.id, r.iic, r.fic, r.requestXml ?? null, r.responseXml ?? null]);
      ok++;
    } catch (e) {
      await pool.query(`UPDATE fiscal_documents SET status='failed', attempts=attempts+1, last_error=$2, updated_at=now() WHERE id=$1`, [d.id, (e as Error).message]);
    }
  }
  const pending = (await pool.query("SELECT count(*)::int AS n FROM fiscal_documents WHERE status IN ('pending','failed')")).rows[0].n;
  fiscalQueue.set(pending);
  return { processed: docs.length, ok };
}

export function startFiscalWorker(log: (m: string) => void) {
  const provider = providerFromConfig();
  if (!provider) return () => {};
  const t = setInterval(async () => {
    const got = await redis.set('globi:lock:fiscal', process.pid.toString(), 'EX', 30, 'NX').catch(() => null);
    if (!got) return;
    try { await processFiscalBatch(provider); } catch (e) { log(`fiscal worker: ${(e as Error).message}`); }
    finally { await redis.del('globi:lock:fiscal').catch(() => {}); }
  }, 5000);
  return () => clearInterval(t);
}
