CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  street TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  city TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  premium BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_order_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','staff','customer','premcustomer'));
UPDATE users SET role='premcustomer', premium=true WHERE premium=true AND role='customer';

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  purchase_price_cents INT NOT NULL DEFAULT 0 CHECK (purchase_price_cents >= 0),
  target_profit_percent INT NOT NULL DEFAULT 0 CHECK (target_profit_percent >= 0),
  discount_percent INT NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price_cents INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS target_profit_percent INT NOT NULL DEFAULT 0;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_purchase_price_cents_check;
ALTER TABLE products ADD CONSTRAINT products_purchase_price_cents_check CHECK (purchase_price_cents >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_target_profit_percent_check;
ALTER TABLE products ADD CONSTRAINT products_target_profit_percent_check CHECK (target_profit_percent >= 0);

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  stock INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, name)
);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stock INT NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity INT NOT NULL CHECK (quantity > 0)
);
ALTER TABLE carts ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE carts ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS variety TEXT NOT NULL DEFAULT '';
ALTER TABLE carts DROP CONSTRAINT IF EXISTS carts_pkey;
UPDATE carts SET id = gen_random_uuid() WHERE id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='carts_id_pkey') THEN
    ALTER TABLE carts ADD CONSTRAINT carts_id_pkey PRIMARY KEY (id);
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  assigned_staff_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Placed',
  payment_status TEXT NOT NULL DEFAULT 'Unpaid',
  delivery_status TEXT NOT NULL DEFAULT 'Not Started',
  payment_method TEXT NOT NULL DEFAULT 'Vorauszahlung',
  address_snapshot TEXT NOT NULL,
  total_cents INT NOT NULL DEFAULT 0,
  customer_seen_at TIMESTAMPTZ,
  staff_seen_at TIMESTAMPTZ,
  archived_by_staff BOOLEAN NOT NULL DEFAULT FALSE,
  archived_by_customer BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_staff_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('Placed','Accepted','Denied'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('Paid','Unpaid','Pay on delivery'));
ALTER TABLE orders ADD CONSTRAINT orders_delivery_status_check CHECK (delivery_status IN ('Not Started','Delivery in Progress','Delivered'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('Vorauszahlung','Bei Lieferung'));
UPDATE orders SET delivery_status='Not Started' WHERE status='Placed' AND delivery_status='Delivery in Progress';
UPDATE orders SET payment_status='Pay on delivery' WHERE payment_method='Bei Lieferung';

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  variant_name TEXT,
  variety TEXT NOT NULL DEFAULT '',
  unit_price_cents INT NOT NULL,
  purchase_price_cents INT NOT NULL DEFAULT 0,
  discount_percent INT NOT NULL DEFAULT 0,
  quantity INT NOT NULL CHECK (quantity > 0)
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_name TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variety TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS purchase_price_cents INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);



CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_percent INT NOT NULL DEFAULT 0,
  discount_cents INT NOT NULL DEFAULT 0,
  max_discount_cents INT,
  buy_x INT NOT NULL DEFAULT 0,
  get_y INT NOT NULL DEFAULT 0,
  account_specific_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  min_order_cents INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  max_uses INT,
  used_count INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS discount_percent INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS max_discount_cents INT;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS buy_x INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS get_y INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS account_specific_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS min_order_cents INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS max_uses INT;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS used_count INT NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_discount_type_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_discount_type_check CHECK (discount_type IN ('none','percent','fixed'));
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_discount_percent_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_discount_percent_check CHECK (discount_percent BETWEEN 0 AND 100);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_discount_cents_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_discount_cents_check CHECK (discount_cents >= 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_max_discount_cents_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_max_discount_cents_check CHECK (max_discount_cents IS NULL OR max_discount_cents >= 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_buy_x_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_buy_x_check CHECK (buy_x >= 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_get_y_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_get_y_check CHECK (get_y >= 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_min_order_cents_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_min_order_cents_check CHECK (min_order_cents >= 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_max_uses_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0);
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_used_count_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_used_count_check CHECK (used_count >= 0);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code_id UUID REFERENCES discount_codes(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_discount_cents_check CHECK (discount_cents >= 0);

CREATE TABLE IF NOT EXISTS discount_code_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_code_id UUID REFERENCES discount_codes(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  discount_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE discount_code_redemptions ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_assigned_staff_id ON orders(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_messages_order_id ON messages(order_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_carts_user_id ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);
CREATE INDEX IF NOT EXISTS idx_discount_codes_active ON discount_codes(active);
CREATE INDEX IF NOT EXISTS idx_discount_code_redemptions_code_id ON discount_code_redemptions(discount_code_id);
