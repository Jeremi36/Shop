require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const app = express();
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
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 14, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

const money = cents => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const discounted = p => Math.round(p.price_cents * (100 - p.discount_percent) / 100);

async function currentUser(req, res, next) {
  res.locals.user = null;
  res.locals.cartCount = 0;
  res.locals.notifications = 0;
  res.locals.money = money;
  res.locals.discounted = discounted;
  if (req.session.userId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    res.locals.user = rows[0] || null;
    if (res.locals.user) {
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
function requireStaff(req, res, next) { if (!res.locals.user || res.locals.user.role !== 'staff') return res.status(403).send('Kein Zugriff'); next(); }

app.get('/', async (_, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE active=true ORDER BY created_at DESC');
  res.render('shop', { title: 'Shop', products: rows });
});

app.get('/register', (req, res) => res.render('auth', { title: 'Registrieren', mode: 'register', error: null }));
app.post('/register', async (req, res) => {
  const { email, password, full_name, street, postal_code, city, phone } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`INSERT INTO users (email,password_hash,full_name,street,postal_code,city,phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [email.toLowerCase(), hash, full_name, street, postal_code, city, phone]);
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
  res.redirect(rows[0].role === 'staff' ? '/staff' : '/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.post('/cart/add/:id', requireLogin, async (req, res) => {
  const qty = Math.max(1, parseInt(req.body.quantity || '1', 10));
  const product = await pool.query('SELECT stock FROM products WHERE id=$1 AND active=true', [req.params.id]);
  if (!product.rows[0]) return res.redirect('/');
  await pool.query(`INSERT INTO carts (user_id,product_id,quantity) VALUES ($1,$2,$3)
    ON CONFLICT (user_id,product_id) DO UPDATE SET quantity = LEAST(carts.quantity + EXCLUDED.quantity, $4)`, [res.locals.user.id, req.params.id, qty, product.rows[0].stock]);
  res.redirect('/cart');
});

app.get('/cart', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT c.quantity, p.* FROM carts c JOIN products p ON p.id=c.product_id WHERE c.user_id=$1 ORDER BY p.name`, [res.locals.user.id]);
  const total = rows.reduce((s, r) => s + discounted(r) * r.quantity, 0);
  res.render('cart', { title: 'Warenkorb', items: rows, total });
});
app.post('/cart/update/:id', requireLogin, async (req, res) => {
  const qty = parseInt(req.body.quantity, 10);
  if (qty <= 0) await pool.query('DELETE FROM carts WHERE user_id=$1 AND product_id=$2', [res.locals.user.id, req.params.id]);
  else await pool.query('UPDATE carts SET quantity=$1 WHERE user_id=$2 AND product_id=$3', [qty, res.locals.user.id, req.params.id]);
  res.redirect('/cart');
});

app.post('/orders/place', requireLogin, async (req, res) => {
  const paymentMethod = req.body.payment_method === 'Bei Lieferung' && res.locals.user.premium ? 'Bei Lieferung' : 'Vorauszahlung';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cart = await client.query(`SELECT c.quantity, p.* FROM carts c JOIN products p ON p.id=c.product_id WHERE c.user_id=$1 FOR UPDATE`, [res.locals.user.id]);
    if (!cart.rows.length) throw new Error('Warenkorb ist leer.');
    for (const item of cart.rows) if (item.quantity > item.stock) throw new Error(`${item.name} ist nicht mehr genug auf Lager.`);
    const total = cart.rows.reduce((s, r) => s + discounted(r) * r.quantity, 0);
    const address = `${res.locals.user.full_name}\n${res.locals.user.street}\n${res.locals.user.postal_code} ${res.locals.user.city}\nTelefon: ${res.locals.user.phone || '-'}`;
    const order = await client.query(`INSERT INTO orders (user_id,address_snapshot,total_cents,payment_method) VALUES ($1,$2,$3,$4) RETURNING *`, [res.locals.user.id, address, total, paymentMethod]);
    for (const item of cart.rows) {
      await client.query(`INSERT INTO order_items (order_id,product_id,product_name,unit_price_cents,discount_percent,quantity) VALUES ($1,$2,$3,$4,$5,$6)`, [order.rows[0].id, item.id, item.name, item.price_cents, item.discount_percent, item.quantity]);
      await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, item.id]);
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
  const orderQ = user.role === 'staff'
    ? await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [orderId])
    : await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1 AND o.user_id=$2', [orderId, user.id]);
  return orderQ.rows[0];
}

app.get('/orders', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [res.locals.user.id]);
  res.render('orders', { title: 'Meine Bestellungen', orders: rows });
});
app.get('/orders/:id', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Bestellung nicht gefunden');
  if (res.locals.user.role === 'customer') await pool.query('UPDATE orders SET customer_seen_at=now() WHERE id=$1', [order.id]);
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
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/review', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order || order.delivery_status !== 'Delivered' || res.locals.user.role !== 'customer') return res.status(403).send('Bewertung noch nicht möglich.');
  await pool.query('INSERT INTO reviews (order_id,user_id,rating,comment) VALUES ($1,$2,$3,$4) ON CONFLICT (order_id) DO UPDATE SET rating=$3, comment=$4', [order.id, res.locals.user.id, parseInt(req.body.rating,10), req.body.comment]);
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/archive', requireLogin, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Nicht gefunden');
  const column = res.locals.user.role === 'staff' ? 'archived_by_staff' : 'archived_by_customer';
  await pool.query(`UPDATE orders SET ${column}=true WHERE id=$1`, [order.id]);
  res.redirect(res.locals.user.role === 'staff' ? '/staff/orders' : '/orders');
});

app.get('/staff', requireStaff, async (req, res) => {
  const stats = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM orders WHERE archived_by_staff=false) orders,
    (SELECT COUNT(*)::int FROM orders WHERE status='Placed') due,
    (SELECT COUNT(*)::int FROM products WHERE active=true) products,
    (SELECT COUNT(*)::int FROM users WHERE premium=true) premium`);
  res.render('staff-dashboard', { title: 'Staff Übersicht', stats: stats.rows[0] });
});
app.get('/staff/products', requireStaff, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
  res.render('staff-products', { title: 'Produkte verwalten', products: rows });
});
app.post('/staff/products', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent } = req.body;
  const cents = Math.round(parseFloat(String(price).replace(',', '.')) * 100);
  const imageUrl = req.file ? '/public/uploads/' + req.file.filename : null;
  await pool.query('INSERT INTO products (name,description,price_cents,stock,discount_percent,image_url) VALUES ($1,$2,$3,$4,$5,$6)', [name, description, cents, parseInt(stock,10), parseInt(discount_percent || '0',10), imageUrl]);
  res.redirect('/staff/products');
});
app.post('/staff/products/:id', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, active } = req.body;
  const cents = Math.round(parseFloat(String(price).replace(',', '.')) * 100);
  const imageUrl = req.file ? '/public/uploads/' + req.file.filename : req.body.old_image_url || null;
  await pool.query('UPDATE products SET name=$1, description=$2, price_cents=$3, stock=$4, discount_percent=$5, active=$6, image_url=$7 WHERE id=$8', [name, description, cents, parseInt(stock,10), parseInt(discount_percent || '0',10), active === 'on', imageUrl, req.params.id]);
  res.redirect('/staff/products');
});
app.get('/staff/orders', requireStaff, async (req, res) => {
  const { rows } = await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE archived_by_staff=false ORDER BY o.created_at DESC');
  res.render('staff-orders', { title: 'Bestellungen', orders: rows });
});
app.post('/staff/orders/:id/update', requireStaff, async (req, res) => {
  const before = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  const { status, payment_status, delivery_status } = req.body;
  await pool.query('UPDATE orders SET status=$1,payment_status=$2,delivery_status=$3,updated_at=now() WHERE id=$4', [status, payment_status, delivery_status, req.params.id]);
  if (before.rows[0]?.delivery_status !== 'Delivered' && delivery_status === 'Delivered') {
    await pool.query(`UPDATE users SET delivered_order_count = delivered_order_count + 1,
      premium = CASE WHEN delivered_order_count + 1 >= 5 THEN true ELSE premium END
      WHERE id=(SELECT user_id FROM orders WHERE id=$1)`, [req.params.id]);
  }
  res.redirect('/orders/' + req.params.id);
});
app.get('/staff/customers', requireStaff, async (_, res) => {
  const { rows } = await pool.query('SELECT id,email,full_name,city,premium,delivered_order_count,created_at FROM users WHERE role=$1 ORDER BY created_at DESC', ['customer']);
  res.render('staff-customers', { title: 'Kunden', customers: rows });
});
app.get('/bewertungen', async (_, res) => {
  const { rows } = await pool.query('SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 50');
  res.render('reviews', { title: 'Bewertungen', reviews: rows });
});

app.get('/health', (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Shop läuft auf Port ${port}`));
