// Të dhëna demo për zhvillim: grupi GLOBI me dy subjekte (Piceri dhe Bar Café). NIPT-et janë fiktive.
import { pool } from './db.js';
import { hashSecret, randomToken, sha256 } from './auth/crypto.js';
import { migrate } from './migrate.js';

export async function seed(log = console.log) {
  await migrate(undefined, () => {});
  const exists = await pool.query("SELECT id FROM organizations WHERE name='GLOBI'");
  if (exists.rows[0]) { log('Të dhënat demo ekzistojnë.'); return null; }
  const org = (await pool.query("INSERT INTO organizations(name) VALUES ('GLOBI') RETURNING id")).rows[0].id;
  const mk = async (name: string, legal: string, nipt: string) =>
    (await pool.query('INSERT INTO businesses(org_id,name,legal_name,nipt) VALUES ($1,$2,$3,$4) RETURNING id', [org, name, legal, nipt])).rows[0].id;
  const pizzeria = await mk('Piceri GLOBI', 'GLOBI Piceri SHPK', 'L00000001A');
  const bar = await mk('Bar Café GLOBI', 'GLOBI Bar SHPK', 'L00000002B');
  const br = async (b: string, name: string) => (await pool.query('INSERT INTO branches(business_id,name,address) VALUES ($1,$2,$3) RETURNING id', [b, name, 'Tiranë'])).rows[0].id;
  const pizBranch = await br(pizzeria, 'Piceri GLOBI – Qendër');
  const barBranch = await br(bar, 'Bar Café GLOBI – Qendër');

  const user = async (fullName: string, roles: [string, string | null, string | null][], email?: string, password?: string, pin?: string) => {
    const id = (await pool.query('INSERT INTO users(org_id,full_name,email,password_hash,pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [org, fullName, email ?? null, password ? await hashSecret(password) : null, pin ? await hashSecret(pin) : null])).rows[0].id;
    for (const [role, b, brn] of roles) await pool.query('INSERT INTO user_roles(user_id,role,business_id,branch_id) VALUES ($1,$2,$3,$4)', [id, role, b, brn]);
    return id;
  };
  const owner = await user('Pronari GLOBI', [['owner', null, null]], 'pronari@globi.local', 'Ndrysho-Kete-2026!', '9999');
  const cashier = await user('Arkëtari Piceri', [['cashier', pizzeria, pizBranch]], undefined, undefined, '1234');
  const waiter = await user('Kamarieri Bar', [['waiter', bar, barBranch]], undefined, undefined, '2345');
  const driver = await user('Shoferi 1', [['driver', pizzeria, pizBranch]], undefined, undefined, '3456');
  const kitchen = await user('Kuzhina', [['kitchen', pizzeria, pizBranch]], undefined, undefined, '4567');

  const tokens: Record<string, string> = {};
  const dev = async (b: string, brn: string, name: string, kind = 'pos') => {
    const t = randomToken(32);
    const id = (await pool.query('INSERT INTO devices(branch_id,business_id,name,kind,token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [brn, b, name, kind, sha256(t)])).rows[0].id;
    tokens[name] = t;
    return id;
  };
  await dev(pizzeria, pizBranch, 'Arka 1 Piceri');
  await dev(pizzeria, pizBranch, 'Kuzhina Piceri', 'kitchen');
  await dev(bar, barBranch, 'Arka 1 Bar');

  const cat = async (b: string, name: string) => (await pool.query('INSERT INTO product_categories(business_id,name) VALUES ($1,$2) RETURNING id', [b, name])).rows[0].id;
  const prod = async (b: string, c: string, name: string, price: number, cost: number, track = false) =>
    (await pool.query('INSERT INTO products(business_id,category_id,name,price,cost,track_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [b, c, name, price, cost, track])).rows[0].id;
  const pz = await cat(pizzeria, 'Pica');
  const dr = await cat(pizzeria, 'Pije');
  await prod(pizzeria, pz, 'Margarita', 600, 180);
  await prod(pizzeria, pz, 'Capricciosa', 800, 260);
  await prod(pizzeria, pz, 'Quattro Formaggi', 900, 320);
  const cola = await prod(pizzeria, dr, 'Coca-Cola 0.33', 200, 90, true);
  await pool.query('INSERT INTO inventory_levels(branch_id,product_id,business_id,qty,min_qty) VALUES ($1,$2,$3,48,12)', [pizBranch, cola, pizzeria]);
  const cf = await cat(bar, 'Kafe');
  await prod(bar, cf, 'Espresso', 100, 25);
  await prod(bar, cf, 'Cappuccino', 150, 40);
  await prod(bar, cf, 'Macchiato', 120, 30);

  const out = { org, pizzeria, bar, pizBranch, barBranch, owner, cashier, waiter, driver, kitchen, tokens };
  log('U krijuan të dhënat demo:');
  log('  Pronari: pronari@globi.local / Ndrysho-Kete-2026!');
  log('  PIN-et: arkëtari 1234, kamarieri 2345, shoferi 3456, kuzhina 4567');
  for (const [n, t] of Object.entries(tokens)) log(`  Token terminali "${n}": ${t}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then(() => pool.end());
}
