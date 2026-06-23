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
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','staff','co_owner','senior_staff','junior_staff','new_staff','customer','premcustomer','veteran_customer','og_customer'));
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
  staff_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price_cents INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS target_profit_percent INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS staff_note TEXT NOT NULL DEFAULT '';
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
  staff_note_snapshot TEXT NOT NULL DEFAULT '',
  prepared BOOLEAN NOT NULL DEFAULT FALSE,
  quantity INT NOT NULL CHECK (quantity > 0)
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_name TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variety TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS purchase_price_cents INT NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS staff_note_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS prepared BOOLEAN NOT NULL DEFAULT FALSE;

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

-- Google-Drive-Bildlinks bleiben als alte Links erhalten. Neue Uploads nutzen Cloudinary.
-- Erweiterungen: Produktdetails, Bans, Kundennotizen, Treffpunkte, Extra-Kosten
ALTER TABLE products ADD COLUMN IF NOT EXISTS views_count INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS meeting_location TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS meeting_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extra_cost_cents INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extra_cost_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_extra_cost_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_extra_cost_cents_check CHECK (extra_cost_cents >= 0);

CREATE TABLE IF NOT EXISTS ban_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ban_rules DROP CONSTRAINT IF EXISTS ban_rules_type_check;
ALTER TABLE ban_rules ADD CONSTRAINT ban_rules_type_check CHECK (type IN ('email','ip','identity'));
CREATE INDEX IF NOT EXISTS idx_ban_rules_type_value ON ban_rules(type, value);

-- Produktfilter, Händlerstatus und Standardkategorie
INSERT INTO categories (name, description, active)
VALUES ('Allgemein', 'Automatisch erstellte Standard-Kategorie', true)
ON CONFLICT (name) DO UPDATE SET active=true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_status_note TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_checked_at TIMESTAMPTZ;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_supplier_status_check;
ALTER TABLE products ADD CONSTRAINT products_supplier_status_check CHECK (supplier_status IN ('unknown','in_stock','out_of_stock'));
UPDATE products SET category_id = (SELECT id FROM categories WHERE name='Allgemein' LIMIT 1) WHERE category_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_views_count ON products(views_count);
CREATE INDEX IF NOT EXISTS idx_products_supplier_status ON products(supplier_status);


-- Globale App-Einstellungen, z.B. Cooldown für automatische Händlerchecks
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Age verification, editable legal pages, order timeline, audit log
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_level INT NOT NULL DEFAULT 0;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_verification_level_check;
ALTER TABLE users ADD CONSTRAINT users_verification_level_check CHECK (verification_level IN (0,16,18));

ALTER TABLE categories ADD COLUMN IF NOT EXISTS age_level INT NOT NULL DEFAULT 0;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_age_level_check;
ALTER TABLE categories ADD CONSTRAINT categories_age_level_check CHECK (age_level IN (0,16,18));

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS image_url TEXT;

INSERT INTO app_settings (key,value,updated_at) VALUES ('age_restriction_enabled','false',now()) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS legal_pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO legal_pages (slug,title,body) VALUES
('impressum','Impressum','Bitte trage hier dein Impressum ein. Wichtig: Diese Vorlage ersetzt keine Rechtsberatung.'),
('datenschutz','Datenschutzerklärung','Bitte trage hier deine Datenschutzerklärung ein. Wichtig: Diese Vorlage ersetzt keine Rechtsberatung.'),
('agb','AGB','Bitte trage hier deine AGB ein. Wichtig: Diese Vorlage ersetzt keine Rechtsberatung.'),
('widerruf','Widerrufsbelehrung','Bitte trage hier deine Widerrufsbelehrung ein. Wichtig: Diese Vorlage ersetzt keine Rechtsberatung.'),
('kontakt','Kontakt','Bitte trage hier deine Kontaktinformationen ein.'),
('lieferung','Liefer-/Übergabeinfo','Bestellungen werden lokal übergeben. Details werden über das Support-/Bestellfenster abgestimmt.'),
('zahlung','Zahlungsinfo','Aktuell werden Zahlungsdetails individuell abgestimmt.')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);


-- Phase 2: Support, Staff-Rechte, Gutscheine/Guthaben und Terminbestätigung
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_cents INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_suspension_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_credit_cents_check;
ALTER TABLE users ADD CONSTRAINT users_credit_cents_check CHECK (credit_cents >= 0);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_total_cents INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_used_cents INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS legal_accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS meeting_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS meeting_proposed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone_snapshot TEXT NOT NULL DEFAULT '';
UPDATE orders SET customer_name_snapshot=COALESCE(NULLIF(customer_name_snapshot,''),(SELECT full_name FROM users WHERE users.id=orders.user_id),''), customer_email_snapshot=COALESCE(NULLIF(customer_email_snapshot,''),(SELECT email FROM users WHERE users.id=orders.user_id),''), customer_phone_snapshot=COALESCE(NULLIF(customer_phone_snapshot,''),(SELECT phone FROM users WHERE users.id=orders.user_id),'') WHERE customer_name_snapshot='' OR customer_email_snapshot='';
UPDATE orders SET original_total_cents=total_cents + COALESCE(credit_used_cents,0) WHERE original_total_cents=0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_original_total_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_original_total_cents_check CHECK (original_total_cents >= 0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_credit_used_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_credit_used_cents_check CHECK (credit_used_cents >= 0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_meeting_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_meeting_status_check CHECK (meeting_status IN ('none','proposed','confirmed','rejected','customer_proposed'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('Vorauszahlung','Bei Lieferung','Guthaben'));

CREATE TABLE IF NOT EXISTS staff_permissions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  can_manage_orders BOOLEAN NOT NULL DEFAULT TRUE,
  can_manage_support BOOLEAN NOT NULL DEFAULT TRUE,
  can_edit_products BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_prices BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete_products BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_discounts BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_users BOOLEAN NOT NULL DEFAULT FALSE,
  can_ban_users BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_gift_cards BOOLEAN NOT NULL DEFAULT TRUE,
  can_adjust_credit BOOLEAN NOT NULL DEFAULT FALSE,
  can_verify_age BOOLEAN NOT NULL DEFAULT TRUE,
  can_manage_meetings BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO staff_permissions (user_id)
SELECT id FROM users WHERE role='staff'
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS support_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO support_faqs (question,answer,sort_order)
SELECT * FROM (VALUES
  ('Wie werde ich für 16+/18+ Kategorien verifiziert?','Öffne eine Support-Konversation. Ein Mitarbeiter kann deine Altersfreigabe nach einer geeigneten Prüfung auf 16+ oder 18+ setzen.',10),
  ('Wo sehe ich meine Bestellung?','Unter „Meine Bestellungen“ siehst du Status, Treffpunkt, Nachrichten und die Bestell-Timeline.',20),
  ('Wie kann ich eine Sperre oder Bestellung anfechten?','Wähle im Support „Sperre/Bestellung anfechten“ und beschreibe den Fall. Der Support prüft die Konversation.',30),
  ('Wie funktionieren Gutscheine und Guthaben?','Ein Gutschein wird nach bestätigter Zahlung als PDF mit Code bereitgestellt. Der Code kann unter „Mein Konto“ eingelöst werden.',40)
) AS defaults(question,answer,sort_order)
WHERE NOT EXISTS (SELECT 1 FROM support_faqs);

CREATE TABLE IF NOT EXISTS support_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_no BIGSERIAL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_staff_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'Allgemein',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
ALTER TABLE support_conversations DROP CONSTRAINT IF EXISTS support_conversations_status_check;
ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_status_check CHECK (status IN ('open','waiting_customer','waiting_staff','closed'));
CREATE INDEX IF NOT EXISTS idx_support_conversations_user ON support_conversations(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_staff ON support_conversations(assigned_staff_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id,created_at);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL,
  transaction_type TEXT NOT NULL,
  reference_type TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS gift_card_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_staff_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  custom_message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
ALTER TABLE gift_card_orders DROP CONSTRAINT IF EXISTS gift_card_orders_status_check;
ALTER TABLE gift_card_orders ADD CONSTRAINT gift_card_orders_status_check CHECK (status IN ('requested','paid','cancelled'));
CREATE INDEX IF NOT EXISTS idx_gift_card_orders_staff ON gift_card_orders(assigned_staff_id,status,created_at);

CREATE TABLE IF NOT EXISTS gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_order_id UUID UNIQUE REFERENCES gift_card_orders(id) ON DELETE SET NULL,
  code TEXT UNIQUE NOT NULL,
  value_cents INT NOT NULL CHECK (value_cents > 0),
  remaining_cents INT NOT NULL CHECK (remaining_cents >= 0),
  purchaser_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  custom_message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  download_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ
);
ALTER TABLE gift_cards DROP CONSTRAINT IF EXISTS gift_cards_status_check;
ALTER TABLE gift_cards ADD CONSTRAINT gift_cards_status_check CHECK (status IN ('active','redeemed','void'));
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);

INSERT INTO app_settings (key,value,updated_at) VALUES
('registration_code_enabled','false',now()),
('registration_code','',now())
ON CONFLICT (key) DO NOTHING;

-- Sicherere Starttexte: nur bisherige Platzhalter ersetzen. Vor Live-Betrieb juristisch prüfen lassen.
UPDATE legal_pages SET body='Anbieterkennzeichnung gemäß den anwendbaren gesetzlichen Vorgaben. Bitte ergänze vollständigen Namen/Firma, ladungsfähige Anschrift, Kontaktmöglichkeiten, Vertretungsberechtigte und gegebenenfalls Register-/USt.-Angaben. Diese Startvorlage ersetzt keine Rechtsberatung.' WHERE slug='impressum' AND body LIKE 'Bitte trage hier dein Impressum%';
UPDATE legal_pages SET body='Hier müssen insbesondere Verantwortlicher, Zwecke und Rechtsgrundlagen der Verarbeitung, Empfänger/Auftragsverarbeiter (z. B. Render, Neon, Cloudinary, MailerSend), Speicherdauer, Betroffenenrechte, Cookies/Sessions und Kontaktangaben vollständig beschrieben werden. Diese Startvorlage ersetzt keine Rechtsberatung.' WHERE slug='datenschutz' AND body LIKE 'Bitte trage hier deine Datenschutzerklärung%';
UPDATE legal_pages SET body='Mit dem Absenden über die Schaltfläche „Zahlungspflichtig bestellen“ gibt der Kunde eine zahlungspflichtige Bestellung ab. Annahme, Übergabe, Fälligkeit und Folgen einer Nichtabnahme sind hier rechtssicher zu regeln. Gesetzliche Verbraucherrechte, Gewährleistungsrechte und zwingende Widerrufsrechte werden nicht ausgeschlossen. Bei altersbeschränkten Waren erfolgt eine erneute Alterskontrolle bei der Übergabe; eine fehlgeschlagene Prüfung kann zur Ablehnung der Übergabe und zur Kontoprüfung führen. Diese Startvorlage muss vor Live-Betrieb rechtlich geprüft und vervollständigt werden.' WHERE slug='agb' AND body LIKE 'Bitte trage hier deine AGB%';
UPDATE legal_pages SET body='Verbrauchern kann bei Fernabsatzverträgen ein gesetzliches Widerrufsrecht zustehen. Ergänze eine zutreffend ausgefüllte Widerrufsbelehrung einschließlich Bedingungen, Fristen, Verfahren und Muster-Widerrufsformular. Ein pauschaler Ausschluss „Rückgabe nur bei Defekt“ ist hier nicht voreingestellt. Diese Startvorlage ersetzt keine Rechtsberatung.' WHERE slug='widerruf' AND body LIKE 'Bitte trage hier deine Widerrufsbelehrung%';
UPDATE legal_pages SET body='Bestellungen werden lokal an einem abgestimmten Treffpunkt übergeben. Treffpunkt und Zeit werden im Bestellbereich vorgeschlagen und vom Kunden bestätigt oder mit einem Gegenvorschlag beantwortet. Bei altersbeschränkten Artikeln wird das Alter bei der Übergabe erneut geprüft.' WHERE slug='lieferung' AND body LIKE 'Bestellungen werden lokal übergeben%';
UPDATE legal_pages SET body='Der beim Checkout angezeigte Restbetrag ist zu bezahlen. Eingesetztes Guthaben wird vom ursprünglichen Bestellwert abgezogen. Deckt Guthaben den Gesamtbetrag vollständig, wird die Bestellung automatisch als bezahlt markiert. Weitere Zahlungs- und Fälligkeitsdetails sind in den AGB vollständig zu regeln.' WHERE slug='zahlung' AND body LIKE 'Aktuell werden Zahlungsdetails%';

-- Phase 3: Kundenränge, Staff-Hierarchie, Benachrichtigungen, Gutschein-Produkt und Freigaben
-- Zuerst die alte Rollenprüfung entfernen, damit bestehende Staff-Konten migriert werden können.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role='senior_staff' WHERE role='staff';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'owner','co_owner','senior_staff','junior_staff','new_staff',
  'customer','premcustomer','veteran_customer','og_customer'
));

ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_manually_set BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_order_updates BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_support_updates BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_discount_updates BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_gift_card_updates BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_rank_updates BOOLEAN NOT NULL DEFAULT TRUE;

CREATE OR REPLACE FUNCTION enforce_single_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.role='owner' AND EXISTS (SELECT 1 FROM users WHERE role='owner' AND id<>NEW.id) THEN
    RAISE EXCEPTION 'Es darf nur einen Owner-Account geben.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_single_owner ON users;
CREATE TRIGGER trg_single_owner BEFORE INSERT OR UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION enforce_single_owner();

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL DEFAULT 'allgemein',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,read_at,created_at DESC);

ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
ALTER TABLE products ADD CONSTRAINT products_product_type_check CHECK (product_type IN ('normal','gift_card'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_card_min_cents INT NOT NULL DEFAULT 500;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_card_max_cents INT NOT NULL DEFAULT 50000;

INSERT INTO categories (name,description,active,age_level)
VALUES ('Gutschein','Personalisierbare Geschenkgutscheine als PDF oder per E-Mail.',true,0)
ON CONFLICT (name) DO UPDATE SET active=true, description=EXCLUDED.description, age_level=0;

INSERT INTO products (name,description,price_cents,purchase_price_cents,target_profit_percent,discount_percent,stock,active,category_id,product_type,gift_card_min_cents,gift_card_max_cents)
SELECT 'Geschenkgutschein','Gestalte einen persönlichen Gutschein. Nach bestätigter Zahlung wird eine PDF erstellt oder an die gewünschte E-Mail-Adresse gesendet.',500,0,0,0,999999,true,c.id,'gift_card',500,50000
FROM categories c WHERE c.name='Gutschein'
AND NOT EXISTS (SELECT 1 FROM products WHERE product_type='gift_card');

ALTER TABLE gift_card_orders ADD COLUMN IF NOT EXISTS design_theme TEXT NOT NULL DEFAULT 'blau';
ALTER TABLE gift_card_orders ADD COLUMN IF NOT EXISTS recipient_name TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_card_orders ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_card_orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'download';
ALTER TABLE gift_card_orders ADD COLUMN IF NOT EXISTS delivery_email TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_card_orders DROP CONSTRAINT IF EXISTS gift_card_orders_delivery_method_check;
ALTER TABLE gift_card_orders ADD CONSTRAINT gift_card_orders_delivery_method_check CHECK (delivery_method IN ('download','email'));

ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS design_theme TEXT NOT NULL DEFAULT 'blau';
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS recipient_name TEXT NOT NULL DEFAULT '';
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT '';

ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS role_scope TEXT NOT NULL DEFAULT '';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS per_user_weekly BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS weekly_period_key TEXT NOT NULL DEFAULT '';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS proposed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS custom_email_subject TEXT NOT NULL DEFAULT '';
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS custom_email_message TEXT NOT NULL DEFAULT '';
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_approval_status_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_approval_status_check CHECK (approval_status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS idx_discount_codes_role_scope ON discount_codes(role_scope);
CREATE INDEX IF NOT EXISTS idx_discount_codes_approval ON discount_codes(approval_status);

CREATE TABLE IF NOT EXISTS product_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INT NOT NULL DEFAULT 0,
  purchase_price_cents INT NOT NULL DEFAULT 0,
  target_profit_percent INT NOT NULL DEFAULT 0,
  discount_percent INT NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  staff_note TEXT NOT NULL DEFAULT '',
  supplier_url TEXT NOT NULL DEFAULT '',
  variants_text TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT NOT NULL DEFAULT '',
  created_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE product_proposals DROP CONSTRAINT IF EXISTS product_proposals_status_check;
ALTER TABLE product_proposals ADD CONSTRAINT product_proposals_status_check CHECK (status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS idx_product_proposals_status ON product_proposals(status,created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_awarded_cents INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_awarded_at TIMESTAMPTZ;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cashback_awarded_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_cashback_awarded_cents_check CHECK (cashback_awarded_cents >= 0);

-- Alte Staff-Berechtigungszeilen bleiben für Kompatibilität bestehen; Rollen-Presets haben in Phase 3 Vorrang.
