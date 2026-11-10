-- GLOBI POS — skema fillestare
-- Hierarkia: organization (grupi i pronarit) -> business (subjekt ligjor me NIPT) -> branch (pikë shitjeje) -> device (terminal)
-- Çdo regjistrim kontabël mban business_id, që subjektet të mos përzihen kurrë.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  legal_name       text NOT NULL,
  nipt             text NOT NULL,
  vat_registered   boolean NOT NULL DEFAULT true,
  default_vat_rate numeric(5,2) NOT NULL DEFAULT 20,
  currency         char(3) NOT NULL DEFAULT 'ALL',
  -- konfigurimi i fiskalizimit: tcr code, business unit, operator codes, etj. Certifikata NUK ruhet këtu.
  fiscal_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pragjet që kërkojnë miratim nga pronari
  approval_rules   jsonb NOT NULL DEFAULT '{"discountPercentMax": 10, "cashDifferenceMax": 500}'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, nipt)
);

CREATE TABLE branches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  name                text NOT NULL,
  address             text,
  fiscal_unit_code    text,           -- kodi i njësisë së biznesit në sistemin e tatimeve
  timezone            text NOT NULL DEFAULT 'Europe/Tirane',
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON branches (business_id);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  full_name      text NOT NULL,
  email          text UNIQUE,
  password_hash  text,
  pin_hash       text,                 -- PIN 4-6 shifror për hyrje në terminal
  totp_secret    text,                 -- 2FA për pronarin/adminët
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner','admin','manager','cashier','waiter','kitchen','warehouse','driver');

-- Një rol mund të jetë në nivel organizate (business_id NULL), biznesi ose pike.
CREATE TABLE user_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         user_role NOT NULL,
  business_id  uuid REFERENCES businesses(id),
  branch_id    uuid REFERENCES branches(id),
  CHECK (branch_id IS NULL OR business_id IS NOT NULL)
);
CREATE UNIQUE INDEX user_roles_uniq ON user_roles (user_id, role, coalesce(business_id, '00000000-0000-0000-0000-000000000000'), coalesce(branch_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   uuid,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE device_kind AS ENUM ('pos','kitchen','bar','warehouse','delivery','admin');

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  name          text NOT NULL,
  kind          device_kind NOT NULL DEFAULT 'pos',
  token_hash    text NOT NULL UNIQUE,  -- token i pajisjes, jepet një herë gjatë regjistrimit
  fiscal_tcr_code text,                -- kodi TCR i arkës fiskale
  is_active     boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== Katalogu dhe inventari =====
CREATE TABLE product_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  name         text NOT NULL,
  sort_order   int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  category_id  uuid REFERENCES product_categories(id),
  name         text NOT NULL,
  sku          text,
  price        numeric(14,2) NOT NULL CHECK (price >= 0),   -- me TVSH
  cost         numeric(14,2) NOT NULL DEFAULT 0,           -- kosto e përllogaritur për fitimin
  vat_rate     numeric(5,2) NOT NULL DEFAULT 20,
  unit         text NOT NULL DEFAULT 'copë',
  track_stock  boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON products (business_id, updated_at);

CREATE TABLE inventory_levels (
  branch_id    uuid NOT NULL REFERENCES branches(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  qty          numeric(14,3) NOT NULL DEFAULT 0,
  min_qty      numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, product_id)
);

CREATE TABLE stock_movements (
  id           bigserial PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  qty_delta    numeric(14,3) NOT NULL,
  reason       text NOT NULL,          -- sale, purchase, waste, adjustment, transfer
  ref_id       uuid,
  user_id      uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements (branch_id, product_id, created_at);

-- ===== Turnet dhe arka =====
CREATE TABLE shifts (
  id             uuid PRIMARY KEY,      -- gjenerohet nga klienti (idempotent)
  business_id    uuid NOT NULL REFERENCES businesses(id),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  device_id      uuid REFERENCES devices(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  opening_cash   numeric(14,2) NOT NULL DEFAULT 0,
  counted_cash   numeric(14,2),
  expected_cash  numeric(14,2),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE UNIQUE INDEX shifts_one_open_per_user_branch ON shifts (branch_id, user_id) WHERE status = 'open';

-- ===== Porositë =====
CREATE TABLE branch_counters (
  branch_id   uuid NOT NULL REFERENCES branches(id),
  day         date NOT NULL,
  last_number int NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, day)
);

CREATE TABLE orders (
  id                 uuid PRIMARY KEY,   -- UUID nga terminali => nuk dyfishohet gjatë sinkronizimit
  business_id        uuid NOT NULL REFERENCES businesses(id),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  device_id          uuid REFERENCES devices(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  shift_id           uuid REFERENCES shifts(id),
  order_number       int NOT NULL,
  business_day       date NOT NULL,
  type               text NOT NULL DEFAULT 'dine_in' CHECK (type IN ('dine_in','takeaway','delivery')),
  table_label        text,
  customer_name      text,
  customer_phone     text,
  delivery_address   text,
  driver_id          uuid REFERENCES users(id),
  delivery_status    text CHECK (delivery_status IN ('pending','assigned','on_the_way','delivered','failed')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
  discount_amount    numeric(14,2) NOT NULL DEFAULT 0,
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  vat_total          numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  paid_total         numeric(14,2) NOT NULL DEFAULT 0,
  note               text,
  created_offline    boolean NOT NULL DEFAULT false,
  client_created_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  version            int NOT NULL DEFAULT 1,
  UNIQUE (branch_id, business_day, order_number),
  CHECK (paid_total <= total OR status = 'cancelled')
);
CREATE INDEX ON orders (business_id, business_day);
CREATE INDEX ON orders (branch_id, status);

CREATE TABLE order_items (
  id           uuid PRIMARY KEY,         -- UUID nga terminali
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  business_id  uuid NOT NULL REFERENCES businesses(id),
  product_id   uuid REFERENCES products(id),
  name         text NOT NULL,
  qty          numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_price   numeric(14,2) NOT NULL,
  unit_cost    numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate     numeric(5,2) NOT NULL,
  line_total   numeric(14,2) NOT NULL,
  note         text,
  kitchen_status text NOT NULL DEFAULT 'new' CHECK (kitchen_status IN ('new','preparing','ready','served','voided')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_items (order_id);

CREATE TABLE payments (
  id            uuid PRIMARY KEY,         -- UUID nga terminali => pagesa e dyfishtë refuzohet nga PK
  order_id      uuid NOT NULL REFERENCES orders(id),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  shift_id      uuid REFERENCES shifts(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  method        text NOT NULL CHECK (method IN ('cash','card','bank','driver_cash')),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  status        text NOT NULL DEFAULT 'captured' CHECK (status IN ('captured','refunded')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (business_id, created_at);
CREATE INDEX ON payments (shift_id);

-- Arkëtimet që shoferi dorëzon në arkë
CREATE TABLE driver_settlements (
  id            uuid PRIMARY KEY,
  business_id   uuid NOT NULL REFERENCES businesses(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  driver_id     uuid NOT NULL REFERENCES users(id),
  shift_id      uuid REFERENCES shifts(id),
  amount        numeric(14,2) NOT NULL,
  received_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id            uuid PRIMARY KEY,
  business_id   uuid NOT NULL REFERENCES businesses(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  shift_id      uuid REFERENCES shifts(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  category      text NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_from_drawer boolean NOT NULL DEFAULT true,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON expenses (business_id, created_at);

-- ===== Fiskalizimi =====
CREATE TABLE fiscal_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  order_id      uuid NOT NULL UNIQUE REFERENCES orders(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fiscalized','failed','not_required')),
  iic           text,      -- kodi unik i faturës (gjenerohet lokalisht)
  fic           text,      -- kodi i fiskalizimit (kthehet nga tatimet)
  issued_at     timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  request_xml   text,
  response_xml  text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fiscal_documents (status) WHERE status IN ('pending','failed');

-- ===== Miratimet, alarmet, auditimi =====
CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  branch_id     uuid REFERENCES branches(id),
  kind          text NOT NULL,          -- cancel_paid_order, refund, discount, cash_difference, ...
  entity_id     uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by  uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE INDEX ON approval_requests (business_id, status);

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  branch_id     uuid REFERENCES branches(id),
  kind          text NOT NULL,
  severity      text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message       text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON alerts (business_id, created_at DESC);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  business_id  uuid,
  branch_id    uuid,
  user_id      uuid,
  device_id    uuid,
  action       text NOT NULL,
  entity       text,
  entity_id    text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (business_id, at DESC);

-- Regjistri i idempotencës për sinkronizimin offline: çdo veprim i terminalit ka op_id unik.
CREATE TABLE sync_ops (
  op_id        uuid PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES devices(id),
  op_type      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('applied','rejected')),
  result       jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_ts    timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sync_ops (device_id, received_at);

-- Auditimi është vetëm-shtim: asnjë UPDATE/DELETE nuk lejohet.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log është vetëm-shtim'; END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
