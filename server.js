require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.set('trust proxy', 1);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, path.join(__dirname, 'public/uploads')),
    filename: (_, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, ''))
  }),
  limits: { fileSize: 3 * 1024 * 1024 }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 14, sameSite: 'lax', secure: 'auto' }
}));

const money = cents => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const discounted = p => Math.round(p.price_cents * (100 - p.discount_percent) / 100);
const staffRoles = ['owner', 'staff'];
const customerRoles = ['customer', 'premcustomer'];
const roleLabel = role => ({ owner:'Owner', staff:'Staff', customer:'Customer', premcustomer:'PremCustomer' }[role] || role);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const mailFrom = process.env.MAIL_FROM || 'Premium Shop <onboarding@resend.dev>';
const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function orderUrl(orderId) { return appUrl ? `${appUrl}/orders/${orderId}` : `/orders/${orderId}`; }
function statusDe(field, value) {
  const labels = {
    status: { Placed: 'Aufgegeben', Accepted: 'Angenommen', Denied: 'Abgelehnt' },
    payment_status: { Paid: 'Bezahlt', Unpaid: 'Unbezahlt' },
    delivery_status: { 'Delivery in Progress': 'Lieferung in Bearbeitung', Delivered: 'Geliefert' }
  };
  return labels[field]?.[value] || value;
}
function fieldDe(field) {
  return { status: 'Bestellstatus', payment_status: 'Zahlungsstatus', delivery_status: 'Lieferstatus' }[field] || field;
}
async function sendMail(to, subject, html, text) {
  if (!resend || !to) {
    console.log('[Mail übersprungen] RESEND_API_KEY oder Empfänger fehlt:', subject);
    return;
  }
  try {
    const recipients = Array.isArray(to) ? to.filter(Boolean) : [to];
    if (!recipients.length) return;
    const result = await resend.emails.send({ from: mailFrom, to: recipients, subject, html, text: text || html.replace(/<[^>]*>/g, ' ') });
    if (result.error) console.error('[Resend Fehler]', result.error);
  } catch (err) {
    console.error('[Mail Fehler]', err.message);
  }
}
async function emailOrderStatusUpdate(orderId, before, after) {
  const changes = ['status','payment_status','delivery_status'].filter(f => before[f] !== after[f]);
  if (!changes.length) return;
  const { rows } = await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [orderId]);
  const order = rows[0];
  if (!order) return;
  const list = changes.map(f => `<li><b>${fieldDe(f)}:</b> ${escapeHtml(statusDe(f, before[f]))} → ${escapeHtml(statusDe(f, after[f]))}</li>`).join('');
  await sendMail(
    order.email,
    `Premium Shop: Update zu deiner Bestellung`,
    `<h2>Update zu deiner Bestellung</h2><p>Hallo ${escapeHtml(order.full_name)},</p><p>bei deiner Bestellung gab es ein Update:</p><ul>${list}</ul><p><a href="${escapeHtml(orderUrl(order.id))}">Bestellung öffnen</a></p><p>Premium Shop</p>`,
    `Update zu deiner Bestellung: ${changes.map(f => `${fieldDe(f)}: ${statusDe(f, before[f])} -> ${statusDe(f, after[f])}`).join(', ')}. ${orderUrl(order.id)}`
  );
}
async function emailNewMessage(order, sender, body) {
  const isSenderStaff = staffRoles.includes(sender.role);
  let recipients = [];
  if (isSenderStaff) {
    recipients = [order.email];
  } else {
    const staff = await pool.query("SELECT email FROM users WHERE role IN ('owner','staff')");
    recipients = staff.rows.map(r => r.email);
  }
  const preview = escapeHtml(String(body || '').slice(0, 500));
  await sendMail(
    recipients,
    `Premium Shop: Neue Nachricht zu Bestellung`,
    `<h2>Neue Nachricht</h2><p><b>${escapeHtml(sender.full_name)}</b> hat eine Nachricht zur Bestellung geschrieben:</p><blockquote>${preview}</blockquote><p><a href="${escapeHtml(orderUrl(order.id))}">Konversation öffnen</a></p><p>Premium Shop</p>`,
    `Neue Nachricht von ${sender.full_name}: ${String(body || '').slice(0, 500)} ${orderUrl(order.id)}`
  );
}

async function currentUser(req, res, next) {
  res.locals.user = null;
  res.locals.cartCount = 0;
  res.locals.notifications = 0;
  res.locals.money = money;
  res.locals.discounted = discounted;
  res.locals.roleLabel = roleLabel;
  res.locals.isStaff = false;
  res.locals.isOwner = false;
  res.locals.isCustomer = false;
  if (req.session.userId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    res.locals.user = rows[0] || null;
    if (res.locals.user) {
      res.locals.isStaff = staffRoles.includes(res.locals.user.role);
      res.locals.isOwner = res.locals.user.role === 'owner';
      res.locals.isCustomer = customerRoles.includes(res.locals.user.role);
      const cc = await pool.query('SELECT COALESCE(SUM(quantity),0)::int AS count FROM carts WHERE user_id=$1', [res.locals.user.id]);
      res.locals.cartCount = cc.rows[0].count;
      const nn = await pool.query(`
        SELECT COUNT(*)::int AS count FROM orders o
        WHERE o.user_id=$1 AND (o.customer_seen_at IS NULL OR o.updated_at > o.customer_seen_at
          OR EXISTS (SELECT 1 FROM messages m WHERE m.order_id=o.id AND m.sender_id<>$1 AND (o.customer_seen_at IS NULL OR m.created_at > o.customer_seen_at)))
      `, [res.locals.user.id]);
      res.locals.notifications = nn.rows[0].count;
    }
  }
  next();
}
app.use(currentUser);

function requireLogin(req, res, next) { if (!res.locals.user) return res.redirect('/login'); next(); }
function requireStaff(req, res, next) { if (!res.locals.isStaff) return res.status(403).send('Kein Zugriff'); next(); }
function requireOwner(req, res, next) { if (!res.locals.isOwner) return res.status(403).send('Nur Owner dürfen Rollen ändern.'); next(); }
function requireCustomer(req, res, next) { if (!res.locals.isCustomer) return res.status(403).send('Nur Kunden können das machen.'); next(); }

async function attachVariants(products) {
  if (!products.length) return products;
  const ids = products.map(p => p.id);
  const { rows } = await pool.query('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY name', [ids]);
  const byProduct = {};
  rows.forEach(v => { (byProduct[v.product_id] ||= []).push(v); });
  return products.map(p => ({ ...p, variants: byProduct[p.id] || [] }));
}

app.get('/', async (req, res) => {
  const categoryId = req.query.kategorie || '';
  const categories = await pool.query('SELECT * FROM categories WHERE active=true ORDER BY name');
  const products = categoryId
    ? await pool.query(`SELECT p.*, c.name AS category_name, COALESCE((SELECT SUM(stock) FROM product_variants v WHERE v.product_id=p.id), p.stock)::int AS display_stock FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=true AND p.category_id=$1 ORDER BY p.created_at DESC`, [categoryId])
    : await pool.query(`SELECT p.*, c.name AS category_name, COALESCE((SELECT SUM(stock) FROM product_variants v WHERE v.product_id=p.id), p.stock)::int AS display_stock FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=true ORDER BY p.created_at DESC`);
  const productsWithVariants = await attachVariants(products.rows);
  res.render('shop', { title: 'Shop', products: productsWithVariants, categories: categories.rows, selectedCategory: categoryId });
});

app.get('/register', (req, res) => res.render('auth', { title: 'Registrieren', mode: 'register', error: null }));
app.post('/register', async (req, res) => {
  const { email, password, full_name, street, postal_code, city, phone } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`INSERT INTO users (email,password_hash,full_name,street,postal_code,city,phone,role) VALUES ($1,$2,$3,$4,$5,$6,$7,'customer') RETURNING id`, [email.toLowerCase(), hash, full_name, street, postal_code, city, phone]);
    req.session.userId = rows[0].id;
    res.redirect('/');
  } catch (_) {
    res.status(400).render('auth', { title: 'Registrieren', mode: 'register', error: 'Diese E-Mail existiert bereits oder die Angaben sind ungültig.' });
  }
});

app.get('/login', (req, res) => res.render('auth', { title: 'Einloggen', mode: 'login', error: null }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).render('auth', { title: 'Einloggen', mode: 'login', error: 'E-Mail oder Passwort falsch.' });
  }
  req.session.userId = rows[0].id;
  res.redirect(staffRoles.includes(rows[0].role) ? '/staff' : '/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.post('/cart/add/:id', requireLogin, requireCustomer, async (req, res) => {
  const qty = Math.max(1, parseInt(req.body.quantity || '1', 10));
  const variantId = req.body.variant_id || null;
  const product = await pool.query('SELECT stock FROM products WHERE id=$1 AND active=true', [req.params.id]);
  if (!product.rows[0]) return res.redirect('/');
  const variants = await pool.query('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY name', [req.params.id]);
  let maxStock = product.rows[0].stock;
  if (variants.rows.length) {
    const selected = variants.rows.find(v => v.id === variantId);
    if (!selected) return res.status(400).send('Bitte wähle eine Sorte aus.');
    maxStock = selected.stock;
  }
  const existing = await pool.query('SELECT * FROM carts WHERE user_id=$1 AND product_id=$2 AND ((variant_id IS NULL AND $3::uuid IS NULL) OR variant_id=$3::uuid) LIMIT 1', [res.locals.user.id, req.params.id, variantId]);
  if (existing.rows[0]) {
    await pool.query('UPDATE carts SET quantity=$1 WHERE id=$2', [Math.min(existing.rows[0].quantity + qty, maxStock), existing.rows[0].id]);
  } else {
    await pool.query('INSERT INTO carts (user_id,product_id,variant_id,quantity) VALUES ($1,$2,$3,$4)', [res.locals.user.id, req.params.id, variantId, Math.min(qty, maxStock)]);
  }
  res.redirect('/cart');
});

app.get('/cart', requireLogin, requireCustomer, async (req, res) => {
  const { rows } = await pool.query(`SELECT c.id AS cart_id, c.quantity, c.variant_id, p.*, v.name AS variant_name, COALESCE(v.stock, p.stock) AS stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 ORDER BY p.name, v.name`, [res.locals.user.id]);
  const total = rows.reduce((s, r) => s + discounted(r) * r.quantity, 0);
  res.render('cart', { title: 'Warenkorb', items: rows, total });
});
app.post('/cart/update/:id', requireLogin, requireCustomer, async (req, res) => {
  const qty = parseInt(req.body.quantity, 10);
  if (qty <= 0) await pool.query('DELETE FROM carts WHERE user_id=$1 AND id=$2', [res.locals.user.id, req.params.id]);
  else await pool.query('UPDATE carts SET quantity=$1 WHERE user_id=$2 AND id=$3', [qty, res.locals.user.id, req.params.id]);
  res.redirect('/cart');
});

app.post('/orders/place', requireLogin, requireCustomer, async (req, res) => {
  const canPayDelivery = res.locals.user.role === 'premcustomer' || res.locals.user.premium;
  const paymentMethod = req.body.payment_method === 'Bei Lieferung' && canPayDelivery ? 'Bei Lieferung' : 'Vorauszahlung';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cart = await client.query(`SELECT c.quantity, c.variant_id, p.*, v.name AS variant_name, COALESCE(v.stock, p.stock) AS available_stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 FOR UPDATE`, [res.locals.user.id]);
    if (!cart.rows.length) throw new Error('Warenkorb ist leer.');
    for (const item of cart.rows) if (item.quantity > item.available_stock) throw new Error(`${item.name}${item.variant_name ? ' (' + item.variant_name + ')' : ''} ist nicht mehr genug auf Lager.`);
    const total = cart.rows.reduce((s, r) => s + discounted(r) * r.quantity, 0);
    const address = `${res.locals.user.full_name}\n${res.locals.user.street}\n${res.locals.user.postal_code} ${res.locals.user.city}\nTelefon: ${res.locals.user.phone || '-'}`;
    const order = await client.query(`INSERT INTO orders (user_id,address_snapshot,total_cents,payment_method) VALUES ($1,$2,$3,$4) RETURNING *`, [res.locals.user.id, address, total, paymentMethod]);
    for (const item of cart.rows) {
      await client.query(`INSERT INTO order_items (order_id,product_id,product_name,variant_name,unit_price_cents,discount_percent,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [order.rows[0].id, item.id, item.name, item.variant_name || null, item.price_cents, item.discount_percent, item.quantity]);
      if (item.variant_id) await client.query('UPDATE product_variants SET stock=stock-$1 WHERE id=$2', [item.quantity, item.variant_id]);
      else await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, item.id]);
    }
    await client.query('DELETE FROM carts WHERE user_id=$1', [res.locals.user.id]);
    await client.query('COMMIT');
    res.redirect('/orders/' + order.rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).send(err.message);
  } finally { client.release(); }
});

async function loadOrderForUser(orderId, user) {
  const orderQ = staffRoles.includes(user.role)
    ? await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [orderId])
    : await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1 AND o.user_id=$2', [orderId, user.id]);
  return orderQ.rows[0];
}

app.get('/orders', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1 AND archived_by_customer=false ORDER BY created_at DESC', [res.locals.user.id]);
  res.render('orders', { title: 'Meine Bestellungen', orders: rows });
});
app.get('/orders/:id', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Bestellung nicht gefunden');
  if (res.locals.isCustomer) await pool.query('UPDATE orders SET customer_seen_at=now() WHERE id=$1', [order.id]);
  const items = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [order.id]);
  const messages = await pool.query('SELECT m.*, u.full_name, u.role FROM messages m JOIN users u ON u.id=m.sender_id WHERE order_id=$1 ORDER BY m.created_at ASC', [order.id]);
  const review = await pool.query('SELECT * FROM reviews WHERE order_id=$1', [order.id]);
  res.render('order-detail', { title: 'Bestellung', order, items: items.rows, messages: messages.rows, review: review.rows[0] });
});
app.post('/orders/:id/message', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Nicht gefunden');
  await pool.query('INSERT INTO messages (order_id,sender_id,body) VALUES ($1,$2,$3)', [order.id, res.locals.user.id, req.body.body]);
  await pool.query('UPDATE orders SET updated_at=now() WHERE id=$1', [order.id]);
  await emailNewMessage(order, res.locals.user, req.body.body);
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/review', requireLogin, requireCustomer, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order || order.delivery_status !== 'Delivered') return res.status(403).send('Bewertung noch nicht möglich.');
  await pool.query('INSERT INTO reviews (order_id,user_id,rating,comment) VALUES ($1,$2,$3,$4) ON CONFLICT (order_id) DO UPDATE SET rating=$3, comment=$4', [order.id, res.locals.user.id, parseInt(req.body.rating,10), req.body.comment]);
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/archive', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Nicht gefunden');
  const column = res.locals.isStaff ? 'archived_by_staff' : 'archived_by_customer';
  await pool.query(`UPDATE orders SET ${column}=true WHERE id=$1`, [order.id]);
  res.redirect(res.locals.isStaff ? '/staff/orders' : '/orders');
});

app.get('/staff', requireStaff, async (req, res) => {
  const stats = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM orders WHERE archived_by_staff=false) orders,
    (SELECT COUNT(*)::int FROM orders WHERE status='Placed') due,
    (SELECT COUNT(*)::int FROM products WHERE active=true) products,
    (SELECT COUNT(*)::int FROM users WHERE role='premcustomer' OR premium=true) premium,
    (SELECT COUNT(*)::int FROM users WHERE role='staff') staff`);
  res.render('staff-dashboard', { title: 'Staff Übersicht', stats: stats.rows[0] });
});
app.get('/staff/products', requireStaff, async (req, res) => {
  const products = await pool.query('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.created_at DESC');
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  const productsWithVariants = await attachVariants(products.rows);
  res.render('staff-products', { title: 'Produkte verwalten', products: productsWithVariants, categories: categories.rows });
});
app.post('/staff/products', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, category_id } = req.body;
  const cents = Math.round(parseFloat(String(price).replace(',', '.')) * 100);
  const imageUrl = req.file ? '/public/uploads/' + req.file.filename : null;
  await pool.query('INSERT INTO products (name,description,price_cents,stock,discount_percent,image_url,category_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [name, description, cents, parseInt(stock,10), parseInt(discount_percent || '0',10), imageUrl, category_id || null]);
  res.redirect('/staff/products');
});
app.post('/staff/products/:id', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, active, category_id } = req.body;
  const cents = Math.round(parseFloat(String(price).replace(',', '.')) * 100);
  const imageUrl = req.file ? '/public/uploads/' + req.file.filename : req.body.old_image_url || null;
  await pool.query('UPDATE products SET name=$1, description=$2, price_cents=$3, stock=$4, discount_percent=$5, active=$6, image_url=$7, category_id=$8 WHERE id=$9', [name, description, cents, parseInt(stock,10), parseInt(discount_percent || '0',10), active === 'on', imageUrl, category_id || null, req.params.id]);
  res.redirect('/staff/products');
});

app.post('/staff/products/:id/variants', requireStaff, async (req, res) => {
  const names = Array.isArray(req.body.variant_name) ? req.body.variant_name : [req.body.variant_name];
  const stocks = Array.isArray(req.body.variant_stock) ? req.body.variant_stock : [req.body.variant_stock];
  const ids = Array.isArray(req.body.variant_id) ? req.body.variant_id : [req.body.variant_id];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim();
    const stock = Math.max(0, parseInt(stocks[i] || '0', 10));
    const id = ids[i];
    if (!id || !name) continue;
    await pool.query('UPDATE product_variants SET name=$1, stock=$2 WHERE id=$3 AND product_id=$4', [name, stock, id, req.params.id]);
  }
  const newName = String(req.body.new_variant_name || '').trim();
  if (newName) {
    await pool.query('INSERT INTO product_variants (product_id,name,stock) VALUES ($1,$2,$3) ON CONFLICT (product_id,name) DO UPDATE SET stock=EXCLUDED.stock', [req.params.id, newName, Math.max(0, parseInt(req.body.new_variant_stock || '0', 10))]);
  }
  res.redirect('/staff/products');
});
app.post('/staff/variants/:id/delete', requireStaff, async (req, res) => {
  await pool.query('DELETE FROM product_variants WHERE id=$1', [req.params.id]);
  res.redirect('/staff/products');
});

app.get('/staff/categories', requireStaff, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY name');
  res.render('staff-categories', { title: 'Kategorien', categories: rows });
});
app.post('/staff/categories', requireStaff, async (req, res) => {
  await pool.query('INSERT INTO categories (name,description,active) VALUES ($1,$2,true) ON CONFLICT (name) DO UPDATE SET description=$2, active=true', [req.body.name, req.body.description || '']);
  res.redirect('/staff/categories');
});
app.post('/staff/categories/:id', requireStaff, async (req, res) => {
  await pool.query('UPDATE categories SET name=$1, description=$2, active=$3 WHERE id=$4', [req.body.name, req.body.description || '', req.body.active === 'on', req.params.id]);
  res.redirect('/staff/categories');
});

app.get('/staff/orders', requireStaff, async (req, res) => {
  const { rows } = await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE archived_by_staff=false ORDER BY o.created_at DESC');
  res.render('staff-orders', { title: 'Bestellungen', orders: rows });
});
app.post('/staff/orders/:id/update', requireStaff, async (req, res) => {
  const before = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  const { status, payment_status, delivery_status } = req.body;
  await pool.query('UPDATE orders SET status=$1,payment_status=$2,delivery_status=$3,updated_at=now() WHERE id=$4', [status, payment_status, delivery_status, req.params.id]);
  const after = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  await emailOrderStatusUpdate(req.params.id, before.rows[0], after.rows[0]);
  if (before.rows[0]?.delivery_status !== 'Delivered' && delivery_status === 'Delivered') {
    await pool.query(`UPDATE users SET delivered_order_count = delivered_order_count + 1,
      premium = CASE WHEN delivered_order_count + 1 >= 5 THEN true ELSE premium END,
      role = CASE WHEN delivered_order_count + 1 >= 5 AND role='customer' THEN 'premcustomer' ELSE role END
      WHERE id=(SELECT user_id FROM orders WHERE id=$1)`, [req.params.id]);
  }
  res.redirect('/orders/' + req.params.id);
});
app.get('/staff/customers', requireStaff, async (_, res) => {
  const { rows } = await pool.query('SELECT id,email,full_name,city,role,premium,delivered_order_count,created_at FROM users ORDER BY created_at DESC');
  res.render('staff-customers', { title: 'Kunden & Rollen', customers: rows });
});
app.post('/staff/users/:id/role', requireOwner, async (req, res) => {
  const allowed = ['owner','staff','customer','premcustomer'];
  const role = allowed.includes(req.body.role) ? req.body.role : 'customer';
  const premium = role === 'premcustomer' || role === 'owner';
  await pool.query('UPDATE users SET role=$1, premium=$2 WHERE id=$3', [role, premium, req.params.id]);
  res.redirect('/staff/customers');
});

app.get('/bewertungen', async (_, res) => {
  const { rows } = await pool.query('SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 50');
  res.render('reviews', { title: 'Bewertungen', reviews: rows });
});

app.get('/health', (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Premium Shop läuft auf Port ${port}`));
