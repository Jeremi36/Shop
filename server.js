require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', 1);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Bitte nur PNG, JPG, JPEG, WEBP oder GIF hochladen.'));
    cb(null, true);
  }
});

const localUploadDir = path.join(__dirname, 'public/uploads');
fs.mkdirSync(localUploadDir, { recursive: true });

function extensionFromFile(file) {
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return byMime[file.mimetype] || path.extname(file.originalname || '').toLowerCase() || '.jpg';
}

const googleDriveConfigured = !!(
  process.env.GOOGLE_DRIVE_FOLDER_ID &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_REFRESH_TOKEN
);
let driveClient = null;
function getDriveClient() {
  if (!googleDriveConfigured) return null;
  if (driveClient) return driveClient;

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

async function deleteOldDriveImages(productId) {
  const drive = getDriveClient();
  if (!drive) return;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false and name contains '${productId}.'`,
    fields: 'files(id,name)',
    pageSize: 50
  });
  for (const file of data.files || []) {
    if (new RegExp(`^${productId}\\.`).test(file.name)) {
      await drive.files.update({ fileId: file.id, requestBody: { trashed: true } });
    }
  }
}

async function storeProductImage(file, productId) {
  if (!file) return null;
  const ext = extensionFromFile(file);
  const fileName = `${productId}${ext}`;

  if (googleDriveConfigured) {
    const drive = getDriveClient();
    await deleteOldDriveImages(productId);
    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: file.mimetype,
        body: Readable.from(file.buffer)
      },
      fields: 'id'
    });
    const fileId = created.data.id;
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }

  for (const old of fs.readdirSync(localUploadDir)) {
    if (old.startsWith(`${productId}.`)) fs.rmSync(path.join(localUploadDir, old), { force: true });
  }
  fs.writeFileSync(path.join(localUploadDir, fileName), file.buffer);
  return `/public/uploads/${fileName}`;
}

async function deleteProductImage(productId) {
  if (googleDriveConfigured) {
    await deleteOldDriveImages(productId);
    return;
  }
  if (fs.existsSync(localUploadDir)) {
    for (const old of fs.readdirSync(localUploadDir)) {
      if (old.startsWith(`${productId}.`)) fs.rmSync(path.join(localUploadDir, old), { force: true });
    }
  }
}

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
function parseVariants(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
}
async function replaceProductVariants(clientOrPool, productId, variants) {
  await clientOrPool.query('UPDATE product_variants SET active=false WHERE product_id=$1', [productId]);
  for (const variant of variants) {
    await clientOrPool.query(`INSERT INTO product_variants (product_id,name,active) VALUES ($1,$2,true)
      ON CONFLICT (product_id,name) DO UPDATE SET active=true`, [productId, variant]);
  }
}
async function validateVariety(productId, selectedVariety) {
  const variants = await pool.query('SELECT name FROM product_variants WHERE product_id=$1 AND active=true ORDER BY name', [productId]);
  if (!variants.rows.length) return '';
  const wanted = String(selectedVariety || '').trim();
  const match = variants.rows.find(v => v.name === wanted);
  if (!match) throw new Error('Bitte wähle eine gültige Sorte aus.');
  return match.name;
}

const mailFrom = process.env.MAIL_FROM || `Premium Shop <${process.env.SMTP_USER || 'no-reply@example.com'}>`;
const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function orderUrl(orderId) { return appUrl ? `${appUrl}/orders/${orderId}` : `/orders/${orderId}`; }
function resetUrl(token) { return appUrl ? `${appUrl}/reset-password/${token}` : `/reset-password/${token}`; }
function statusDe(field, value) {
  const labels = {
    status: { Placed: 'Aufgegeben', Accepted: 'Angenommen', Denied: 'Abgelehnt' },
    payment_status: { Paid: 'Bezahlt', Unpaid: 'Unbezahlt', 'Pay on delivery': 'Bezahlung bei Lieferung' },
    delivery_status: { 'Not Started': 'Noch nicht gestartet', 'Delivery in Progress': 'Lieferung in Bearbeitung', Delivered: 'Geliefert' }
  };
  return labels[field]?.[value] || value;
}
function fieldDe(field) {
  return { status: 'Bestellstatus', payment_status: 'Zahlungsstatus', delivery_status: 'Lieferstatus' }[field] || field;
}
async function sendMail(to, subject, html, text) {
  if (!transporter || !to) {
    console.log('[Mail übersprungen] SMTP-Daten oder Empfänger fehlt:', subject);
    return;
  }
  try {
    const recipients = Array.isArray(to) ? to.filter(Boolean) : [to];
    if (!recipients.length) return;
    await transporter.sendMail({
      from: mailFrom,
      to: recipients.join(','),
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ' ')
    });
    console.log('[Mail gesendet]', subject, 'an', recipients.join(', '));
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
    const staff = await pool.query(`
      SELECT DISTINCT u.email
      FROM users u
      WHERE u.role='owner'
         OR u.id=$1
    `, [order.assigned_staff_id || null]);
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


async function chooseAssignedStaff(client) {
  const { rows } = await client.query(`
    SELECT u.id, COUNT(o.id)::int AS active_orders
    FROM users u
    LEFT JOIN orders o ON o.assigned_staff_id = u.id AND o.status <> 'Denied' AND o.delivery_status <> 'Delivered'
    WHERE u.role IN ('owner','staff')
    GROUP BY u.id
    ORDER BY active_orders ASC, random()
    LIMIT 1
  `);
  return rows[0]?.id || null;
}

async function createPasswordReset(userId, createdBy = null) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token, created_by, expires_at) VALUES ($1,$2,$3,now() + interval '2 hours')`,
    [userId, token, createdBy]
  );
  return token;
}

function priceToCents(value) {
  return Math.max(0, Math.round(parseFloat(String(value || '0').replace(',', '.')) * 100) || 0);
}

function profitPercentFromPrices(priceCents, purchaseCents) {
  if (!purchaseCents) return 0;
  return Math.max(0, Math.round(((priceCents - purchaseCents) / purchaseCents) * 100));
}
function priceCentsFromProfit(purchaseCents, profitPercent) {
  return Math.max(0, Math.round(purchaseCents * (1 + Math.max(0, parseFloat(profitPercent || '0') || 0) / 100)));
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}
function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function euroInputToNullableCents(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  return priceToCents(str);
}
function sumItems(items) {
  return items.reduce((s, r) => s + discounted(r) * r.quantity, 0);
}
function calcBuyXGetYDiscount(eligibleItems, buyX, getY) {
  buyX = Math.max(0, parseInt(buyX || '0', 10));
  getY = Math.max(0, parseInt(getY || '0', 10));
  if (!buyX || !getY) return 0;
  const prices = [];
  for (const item of eligibleItems) {
    const unit = discounted(item);
    for (let i = 0; i < item.quantity; i++) prices.push(unit);
  }
  const groupSize = buyX + getY;
  const freeCount = Math.floor(prices.length / groupSize) * getY;
  if (freeCount <= 0) return 0;
  prices.sort((a, b) => a - b);
  return prices.slice(0, freeCount).reduce((s, v) => s + v, 0);
}
async function calculateDiscountForCode(db, codeInput, user, items, lock=false) {
  const code = normalizeCode(codeInput);
  if (!code) return { valid: false, error: 'Bitte gib einen Rabattcode ein.' };
  const sql = `SELECT * FROM discount_codes WHERE code=$1 ${lock ? 'FOR UPDATE' : ''}`;
  const { rows } = await db.query(sql, [code]);
  const coupon = rows[0];
  if (!coupon) return { valid: false, error: 'Diesen Rabattcode gibt es nicht.' };
  if (!coupon.active) return { valid: false, error: 'Dieser Rabattcode ist deaktiviert.' };
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= Date.now()) return { valid: false, error: 'Dieser Rabattcode ist abgelaufen.' };
  if (coupon.max_uses && coupon.used_count >= coupon.max_uses) return { valid: false, error: 'Dieser Rabattcode wurde bereits zu oft benutzt.' };
  if (coupon.account_specific_user_id && coupon.account_specific_user_id !== user.id) return { valid: false, error: 'Dieser Rabattcode ist nur für einen bestimmten Account gültig.' };

  const subtotal = sumItems(items);
  if (coupon.min_order_cents && subtotal < coupon.min_order_cents) return { valid: false, error: `Mindesteinkaufswert nicht erreicht: ${money(coupon.min_order_cents)}.` };
  const eligibleItems = coupon.category_id ? items.filter(i => i.category_id === coupon.category_id) : items;
  const eligibleSubtotal = sumItems(eligibleItems);
  if (!eligibleItems.length || eligibleSubtotal <= 0) return { valid: false, error: 'Der Rabattcode passt nicht zu den Produkten im Warenkorb.' };

  let discountCents = 0;
  if (coupon.discount_type === 'percent') {
    discountCents += Math.floor(eligibleSubtotal * coupon.discount_percent / 100);
  } else if (coupon.discount_type === 'fixed') {
    discountCents += Math.min(coupon.discount_cents, eligibleSubtotal);
  }
  discountCents += calcBuyXGetYDiscount(eligibleItems, coupon.buy_x, coupon.get_y);
  if (coupon.max_discount_cents !== null && coupon.max_discount_cents !== undefined) {
    discountCents = Math.min(discountCents, coupon.max_discount_cents);
  }
  discountCents = Math.max(0, Math.min(discountCents, subtotal));
  if (discountCents <= 0) return { valid: false, error: 'Dieser Rabattcode bringt für diesen Warenkorb keinen Rabatt.' };
  return { valid: true, coupon, code: coupon.code, discountCents, subtotal, total: subtotal - discountCents };
}
async function loadCartItems(userId, db=pool) {
  const { rows } = await db.query(`SELECT c.id AS cart_id, c.quantity, c.variant_id, p.*, v.name AS variant_name, COALESCE(v.stock, p.stock) AS stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 ORDER BY p.name, v.name`, [userId]);
  return rows;
}

app.get('/', async (req, res) => {
  const categoryId = req.query.kategorie || '';
  const categories = await pool.query('SELECT * FROM categories WHERE active=true ORDER BY name');

  // Wichtig: Keine GROUP BY-Abfrage hier. Alte Deploys konnten auf PostgreSQL mit
  // "column p.id must appear in the GROUP BY clause" crashen. Der Variantenbestand
  // wird sauber über eine Unterabfrage berechnet.
  const baseProductSql = `
    SELECT
      p.id, p.name, p.description, p.price_cents, p.discount_percent,
      p.stock, p.image_url, p.active, p.category_id, p.created_at,
      c.name AS category_name,
      COALESCE((SELECT SUM(v.stock) FROM product_variants v WHERE v.product_id = p.id), p.stock)::int AS display_stock
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = true
  `;

  const products = categoryId
    ? await pool.query(baseProductSql + ' AND p.category_id = $1 ORDER BY p.created_at DESC', [categoryId])
    : await pool.query(baseProductSql + ' ORDER BY p.created_at DESC');

  const productsWithVariants = await attachVariants(products.rows);
  res.render('shop', { title: 'Shop', products: productsWithVariants, categories: categories.rows, selectedCategory: categoryId });
});


app.get('/forgot-password', (req, res) => res.render('auth', { title: 'Passwort vergessen', mode: 'forgot', error: null, success: null }));
app.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const { rows } = await pool.query("SELECT id,email,full_name,role FROM users WHERE email=$1 AND role IN ('customer','premcustomer')", [email]);
  if (rows[0]) {
    const token = await createPasswordReset(rows[0].id);
    await sendMail(rows[0].email, 'Premium Shop: Passwort zurücksetzen', `<h2>Passwort zurücksetzen</h2><p>Hallo ${escapeHtml(rows[0].full_name)},</p><p>Hier kannst du dein Passwort zurücksetzen:</p><p><a href="${escapeHtml(resetUrl(token))}">${escapeHtml(resetUrl(token))}</a></p><p>Der Link ist 2 Stunden gültig.</p>`);
  }
  res.render('auth', { title: 'Passwort vergessen', mode: 'forgot', error: null, success: 'Falls diese E-Mail als Kunde existiert, wurde ein Reset-Link gesendet.' });
});
app.get('/reset-password/:token', async (req, res) => {
  const { rows } = await pool.query('SELECT t.*, u.email FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [req.params.token]);
  if (!rows[0]) return res.status(400).send('Dieser Link ist ungültig oder abgelaufen.');
  res.render('auth', { title: 'Passwort zurücksetzen', mode: 'reset', token: req.params.token, error: null, success: null });
});
app.post('/reset-password/:token', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM password_reset_tokens WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [req.params.token]);
  if (!rows[0]) return res.status(400).send('Dieser Link ist ungültig oder abgelaufen.');
  const hash = await bcrypt.hash(req.body.password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
  await pool.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [rows[0].id]);
  res.redirect('/login');
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
  const items = await loadCartItems(res.locals.user.id);
  const subtotal = sumItems(items);
  let couponResult = null;
  if (req.session.couponCode && items.length) {
    couponResult = await calculateDiscountForCode(pool, req.session.couponCode, res.locals.user, items);
    if (!couponResult.valid) req.session.couponCode = null;
  }
  const couponError = req.session.couponError || null;
  req.session.couponError = null;
  const couponSuccess = req.session.couponSuccess || null;
  req.session.couponSuccess = null;
  const total = couponResult?.valid ? couponResult.total : subtotal;
  res.render('cart', { title: 'Warenkorb', items, subtotal, total, couponResult, couponError, couponSuccess });
});
app.post('/cart/update/:id', requireLogin, requireCustomer, async (req, res) => {
  const qty = parseInt(req.body.quantity, 10);
  if (qty <= 0) await pool.query('DELETE FROM carts WHERE user_id=$1 AND id=$2', [res.locals.user.id, req.params.id]);
  else await pool.query('UPDATE carts SET quantity=$1 WHERE user_id=$2 AND id=$3', [qty, res.locals.user.id, req.params.id]);
  res.redirect('/cart');
});

app.post('/cart/coupon', requireLogin, requireCustomer, async (req, res) => {
  const items = await loadCartItems(res.locals.user.id);
  const result = await calculateDiscountForCode(pool, req.body.code, res.locals.user, items);
  if (!result.valid) {
    req.session.couponCode = null;
    req.session.couponError = result.error;
  } else {
    req.session.couponCode = result.code;
    req.session.couponSuccess = `Rabattcode ${result.code} angewendet: ${money(result.discountCents)} Rabatt.`;
  }
  res.redirect('/cart');
});
app.post('/cart/coupon/remove', requireLogin, requireCustomer, async (req, res) => {
  req.session.couponCode = null;
  req.session.couponSuccess = 'Rabattcode entfernt.';
  res.redirect('/cart');
});

app.post('/orders/place', requireLogin, requireCustomer, async (req, res) => {
  const canPayDelivery = res.locals.user.role === 'premcustomer' || res.locals.user.premium;
  const paymentMethod = req.body.payment_method === 'Bei Lieferung' && canPayDelivery ? 'Bei Lieferung' : 'Vorauszahlung';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cart = await client.query(`SELECT c.id AS cart_id, c.quantity, c.variant_id, p.*, v.name AS variant_name, COALESCE(v.stock, p.stock) AS available_stock, COALESCE(v.stock, p.stock) AS stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 FOR UPDATE OF c,p`, [res.locals.user.id]);
    if (!cart.rows.length) throw new Error('Warenkorb ist leer.');
    for (const item of cart.rows) if (item.quantity > item.available_stock) throw new Error(`${item.name}${item.variant_name ? ' (' + item.variant_name + ')' : ''} ist nicht mehr genug auf Lager.`);
    const subtotal = sumItems(cart.rows);
    let couponResult = null;
    if (req.session.couponCode) {
      couponResult = await calculateDiscountForCode(client, req.session.couponCode, res.locals.user, cart.rows, true);
      if (!couponResult.valid) throw new Error(couponResult.error);
    }
    const discountCents = couponResult?.valid ? couponResult.discountCents : 0;
    const total = subtotal - discountCents;
    const address = `${res.locals.user.full_name}\n${res.locals.user.street}\n${res.locals.user.postal_code} ${res.locals.user.city}\nTelefon: ${res.locals.user.phone || '-'}`;
    const assignedStaffId = await chooseAssignedStaff(client);
    const paymentStatus = paymentMethod === 'Bei Lieferung' ? 'Pay on delivery' : 'Unpaid';
    const order = await client.query(`INSERT INTO orders (user_id,assigned_staff_id,address_snapshot,total_cents,payment_method,payment_status,delivery_status,discount_code_id,discount_code,discount_cents) VALUES ($1,$2,$3,$4,$5,$6,'Not Started',$7,$8,$9) RETURNING *`, [res.locals.user.id, assignedStaffId, address, total, paymentMethod, paymentStatus, couponResult?.coupon?.id || null, couponResult?.code || null, discountCents]);
    if (couponResult?.valid) {
      await client.query('UPDATE discount_codes SET used_count = used_count + 1 WHERE id=$1', [couponResult.coupon.id]);
      await client.query('INSERT INTO discount_code_redemptions (discount_code_id,order_id,user_id,code,discount_cents) VALUES ($1,$2,$3,$4,$5)', [couponResult.coupon.id, order.rows[0].id, res.locals.user.id, couponResult.code, discountCents]);
    }
    for (const item of cart.rows) {
      await client.query(`INSERT INTO order_items (order_id,product_id,product_name,variant_name,variety,unit_price_cents,purchase_price_cents,discount_percent,staff_note_snapshot,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [order.rows[0].id, item.id, item.name, item.variant_name || null, item.variant_name || '', item.price_cents, item.purchase_price_cents || 0, item.discount_percent, item.staff_note || '', item.quantity]);
      if (item.variant_id) await client.query('UPDATE product_variants SET stock=stock-$1 WHERE id=$2', [item.quantity, item.variant_id]);
      else await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, item.id]);
    }
    await client.query('DELETE FROM carts WHERE user_id=$1', [res.locals.user.id]);
    req.session.couponCode = null;
    await client.query('COMMIT');
    res.redirect('/orders/' + order.rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).send(err.message);
  } finally { client.release(); }
});

async function loadOrderForUser(orderId, user) {
  let orderQ;
  if (user.role === 'owner') {
    orderQ = await pool.query('SELECT o.*, u.email, u.full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1', [orderId]);
  } else if (user.role === 'staff') {
    orderQ = await pool.query('SELECT o.*, u.email, u.full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1 AND o.assigned_staff_id=$2', [orderId, user.id]);
  } else {
    orderQ = await pool.query('SELECT o.*, u.email, u.full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1 AND o.user_id=$2', [orderId, user.id]);
  }
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
  const items = await pool.query(`SELECT oi.*, p.staff_note AS current_staff_note FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.product_name, oi.variant_name NULLS LAST`, [order.id]);
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

app.post('/staff/order-items/:itemId/prepared', requireStaff, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT oi.id, oi.order_id, o.assigned_staff_id
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    WHERE oi.id=$1
  `, [req.params.itemId]);
  const item = rows[0];
  if (!item) return res.status(404).send('Artikel nicht gefunden');
  if (!res.locals.isOwner && item.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  await pool.query('UPDATE order_items SET prepared=$1 WHERE id=$2', [req.body.prepared === 'on', item.id]);
  res.redirect('/orders/' + item.order_id);
});

app.get('/staff', requireStaff, async (req, res) => {
  const filter = res.locals.isOwner ? '' : 'AND assigned_staff_id=$1';
  const params = res.locals.isOwner ? [] : [res.locals.user.id];
  const stats = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM orders WHERE archived_by_staff=false AND delivery_status <> 'Delivered' AND status <> 'Denied' ${filter}) orders,
    (SELECT COUNT(*)::int FROM orders WHERE status='Placed' ${filter}) placed,
    (SELECT COUNT(*)::int FROM orders WHERE status='Accepted' AND delivery_status <> 'Delivered' ${filter}) accepted,
    (SELECT COUNT(*)::int FROM orders WHERE delivery_status='Delivered' ${filter}) delivered,
    (SELECT COUNT(*)::int FROM products WHERE active=true) products,
    (SELECT COUNT(*)::int FROM users WHERE role='premcustomer' OR premium=true) premium,
    (SELECT COUNT(*)::int FROM users WHERE role IN ('owner','staff')) staff`, params);
  res.render('staff-dashboard', { title: 'Staff Übersicht', stats: stats.rows[0] });
});
app.get('/staff/products', requireStaff, async (req, res) => {
  const selectedCategory = req.query.kategorie || '';
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  const products = selectedCategory
    ? await pool.query('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.category_id=$1 ORDER BY p.created_at DESC', [selectedCategory])
    : await pool.query('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.created_at DESC');
  const productsWithVariants = await attachVariants(products.rows);
  res.render('staff-products', { title: 'Produkte bearbeiten', products: productsWithVariants, categories: categories.rows, selectedCategory });
});

app.post('/staff/products/discount', requireStaff, async (req, res) => {
  const discount = Math.max(0, Math.min(100, parseInt(req.body.discount_percent || '0', 10)));
  const categoryId = req.body.category_id || null;
  if (categoryId) await pool.query('UPDATE products SET discount_percent=$1 WHERE category_id=$2', [discount, categoryId]);
  else await pool.query('UPDATE products SET discount_percent=$1', [discount]);
  res.redirect('/staff/products' + (categoryId ? '?kategorie=' + encodeURIComponent(categoryId) : ''));
});

app.post('/staff/products', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, category_id, purchase_price, staff_note } = req.body;
  const cents = priceToCents(price);
  const purchaseCents = priceToCents(purchase_price);
  const targetProfit = profitPercentFromPrices(cents, purchaseCents);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query('INSERT INTO products (name,description,price_cents,purchase_price_cents,target_profit_percent,stock,discount_percent,image_url,category_id,staff_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [name, description, cents, purchaseCents, targetProfit, parseInt(stock,10), parseInt(discount_percent || '0',10), null, category_id || null, staff_note || '']);
    const productId = product.rows[0].id;
    const imageUrl = req.file ? await storeProductImage(req.file, productId) : null;
    if (imageUrl) await client.query('UPDATE products SET image_url=$1 WHERE id=$2', [imageUrl, productId]);
    await replaceProductVariants(client, productId, parseVariants(req.body.variants));
    await client.query('COMMIT');
    res.redirect('/staff/products');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).send(err.message);
  } finally { client.release(); }
});
app.post('/staff/products/:id', requireStaff, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, active, category_id, purchase_price, staff_note } = req.body;
  const cents = priceToCents(price);
  const purchaseCents = priceToCents(purchase_price);
  const targetProfit = profitPercentFromPrices(cents, purchaseCents);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const imageUrl = req.file ? await storeProductImage(req.file, req.params.id) : req.body.old_image_url || null;
    await client.query('UPDATE products SET name=$1, description=$2, price_cents=$3, purchase_price_cents=$4, target_profit_percent=$5, stock=$6, discount_percent=$7, active=$8, image_url=$9, category_id=$10, staff_note=$11 WHERE id=$12', [name, description, cents, purchaseCents, targetProfit, parseInt(stock,10), parseInt(discount_percent || '0',10), active === 'on', imageUrl, category_id || null, staff_note || '', req.params.id]);
    await replaceProductVariants(client, req.params.id, parseVariants(req.body.variants));
    await client.query('COMMIT');
    res.redirect('/staff/products');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).send(err.message);
  } finally { client.release(); }
});

app.post('/staff/products/:id/delete', requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productQ = await client.query('SELECT id, name FROM products WHERE id=$1 FOR UPDATE', [req.params.id]);
    const product = productQ.rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      return res.status(404).send('Produkt nicht gefunden');
    }
    await client.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await deleteProductImage(req.params.id);
    res.redirect('/staff/products');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Produkt konnte nicht gelöscht werden.');
  } finally { client.release(); }
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
  const filter = req.query.filter || 'Placed';
  const whereByFilter = {
    Placed: "o.status='Placed' AND o.delivery_status <> 'Delivered'",
    Accepted: "o.status='Accepted' AND o.delivery_status <> 'Delivered'",
    Denied: "o.status='Denied'",
    Paid: "o.payment_status='Paid' AND o.delivery_status <> 'Delivered' AND o.status <> 'Denied'",
    Unpaid: "o.payment_status='Unpaid' AND o.delivery_status <> 'Delivered' AND o.status <> 'Denied'",
    'Delivery in Progress': "o.delivery_status='Delivery in Progress' AND o.status <> 'Denied'",
    Delivered: "o.delivery_status='Delivered' AND o.status <> 'Denied'"
  }[filter] || "o.status='Placed'";
  const params = [];
  let staffWhere = '';
  if (!res.locals.isOwner) { params.push(res.locals.user.id); staffWhere = `AND o.assigned_staff_id=$${params.length}`; }
  const { rows } = await pool.query(`
    SELECT o.*, u.email, u.full_name, s.full_name AS assigned_staff_name, COALESCE(prep.prepared_count,0)::int AS prepared_count, COALESCE(prep.item_count,0)::int AS item_count
    FROM orders o
    JOIN users u ON u.id=o.user_id
    LEFT JOIN users s ON s.id=o.assigned_staff_id
    LEFT JOIN (SELECT order_id, COUNT(*)::int AS item_count, COUNT(*) FILTER (WHERE prepared)::int AS prepared_count FROM order_items GROUP BY order_id) prep ON prep.order_id=o.id
    WHERE o.archived_by_staff=false AND ${whereByFilter} ${staffWhere}
    ORDER BY o.created_at DESC`, params);
  res.render('staff-orders', { title: 'Bestellungen', orders: rows, filter });
});
app.post('/staff/orders/:id/update', requireStaff, async (req, res) => {
  const beforeQ = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  const before = beforeQ.rows[0];
  if (!before) return res.status(404).send('Bestellung nicht gefunden');
  if (!res.locals.isOwner && before.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');

  let status = before.status;
  let payment_status = before.payment_status;
  let delivery_status = before.delivery_status;

  if (req.body.action === 'accept') {
    status = 'Accepted';
    delivery_status = before.delivery_status === 'Not Started' ? 'Delivery in Progress' : before.delivery_status;
  } else if (req.body.action === 'deny') {
    status = 'Denied';
    delivery_status = 'Not Started';
  } else {
    if (req.body.status) status = req.body.status;
    if (status === 'Accepted') {
      if (before.payment_method === 'Bei Lieferung') payment_status = 'Pay on delivery';
      else if (req.body.payment_status) payment_status = req.body.payment_status;
      if (req.body.delivery_status) delivery_status = req.body.delivery_status;
    } else {
      payment_status = before.payment_method === 'Bei Lieferung' ? 'Pay on delivery' : 'Unpaid';
      delivery_status = 'Not Started';
    }
  }

  await pool.query('UPDATE orders SET status=$1,payment_status=$2,delivery_status=$3,updated_at=now() WHERE id=$4', [status, payment_status, delivery_status, req.params.id]);
  const after = (await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
  await emailOrderStatusUpdate(req.params.id, before, after);
  if (before.delivery_status !== 'Delivered' && delivery_status === 'Delivered') {
    await pool.query(`UPDATE users SET delivered_order_count = delivered_order_count + 1,
      premium = CASE WHEN delivered_order_count + 1 >= 5 THEN true ELSE premium END,
      role = CASE WHEN delivered_order_count + 1 >= 5 AND role='customer' THEN 'premcustomer' ELSE role END
      WHERE id=$1`, [before.user_id]);
  }
  res.redirect('/staff/orders?filter=' + encodeURIComponent(status === 'Denied' ? 'Denied' : (delivery_status === 'Delivered' ? 'Delivered' : status))); 
});

app.post('/staff/orders/:id/delete', requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderQ = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    const order = orderQ.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).send('Bestellung nicht gefunden');
    }
    if (req.body.restore_stock === 'on' && order.delivery_status !== 'Delivered') {
      const items = await client.query('SELECT product_id, variant_name, quantity FROM order_items WHERE order_id=$1', [order.id]);
      for (const item of items.rows) {
        if (!item.product_id) continue;
        if (item.variant_name) await client.query('UPDATE product_variants SET stock = stock + $1 WHERE product_id=$2 AND name=$3', [item.quantity, item.product_id, item.variant_name]);
        else await client.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [item.quantity, item.product_id]);
      }
    }
    await client.query('DELETE FROM orders WHERE id=$1', [order.id]);
    await client.query('COMMIT');
    res.redirect('/staff/orders?filter=' + encodeURIComponent(req.body.return_filter || 'Placed'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Bestellung konnte nicht gelöscht werden.');
  } finally { client.release(); }
});

app.get('/staff/discount-codes', requireOwner, async (req, res) => {
  const codes = await pool.query(`SELECT dc.*, c.name AS category_name, u.email AS account_email, creator.full_name AS creator_name
    FROM discount_codes dc
    LEFT JOIN categories c ON c.id=dc.category_id
    LEFT JOIN users u ON u.id=dc.account_specific_user_id
    LEFT JOIN users creator ON creator.id=dc.created_by
    ORDER BY dc.created_at DESC`);
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  const users = await pool.query("SELECT id,email,full_name,role FROM users WHERE role IN ('customer','premcustomer') ORDER BY created_at DESC LIMIT 200");
  res.render('staff-discount-codes', { title: 'Rabattcodes', codes: codes.rows, categories: categories.rows, users: users.rows, error: req.query.error || null });
});
app.post('/staff/discount-codes', requireOwner, async (req, res) => {
  const code = normalizeCode(req.body.code);
  if (!code) return res.redirect('/staff/discount-codes?error=' + encodeURIComponent('Code fehlt.'));
  const discountType = req.body.discount_mode === 'percent' ? 'percent' : req.body.discount_mode === 'fixed' ? 'fixed' : 'none';
  const discountPercent = discountType === 'percent' ? Math.max(0, Math.min(100, parseInt(req.body.discount_percent || '0', 10))) : 0;
  const discountCents = discountType === 'fixed' ? priceToCents(req.body.discount_euro) : 0;
  const maxDiscountCents = req.body.enable_max_discount === 'on' ? euroInputToNullableCents(req.body.max_discount_euro) : null;
  const buyX = req.body.enable_bxgy === 'on' ? Math.max(0, parseInt(req.body.buy_x || '0', 10)) : 0;
  const getY = req.body.enable_bxgy === 'on' ? Math.max(0, parseInt(req.body.get_y || '0', 10)) : 0;
  const accountId = req.body.enable_account === 'on' && req.body.account_specific_user_id ? req.body.account_specific_user_id : null;
  const categoryId = req.body.enable_category === 'on' && req.body.category_id ? req.body.category_id : null;
  const minOrderCents = req.body.enable_min_order === 'on' ? priceToCents(req.body.min_order_euro) : 0;
  const maxUses = req.body.enable_max_uses === 'on' ? intOrNull(req.body.max_uses) : null;

  let expiresAt = null;
  if (req.body.expiry_mode === 'duration') {
    const d = Math.max(0, parseInt(req.body.duration_days || '0', 10));
    const h = Math.max(0, parseInt(req.body.duration_hours || '0', 10));
    const m = Math.max(0, parseInt(req.body.duration_minutes || '0', 10));
    const sec = Math.max(0, parseInt(req.body.duration_seconds || '0', 10));
    if (d || h || m || sec) {
      const q = await pool.query(`SELECT now() + make_interval(days=>$1, hours=>$2, mins=>$3, secs=>$4) AS expires_at`, [d,h,m,sec]);
      expiresAt = q.rows[0].expires_at;
    }
  } else if (req.body.expiry_mode === 'until' && req.body.expires_at_local) {
    const q = await pool.query(`SELECT ($1::timestamp AT TIME ZONE 'Europe/Berlin') AS expires_at`, [req.body.expires_at_local]);
    expiresAt = q.rows[0].expires_at;
  }

  try {
    await pool.query(`INSERT INTO discount_codes (code,description,active,discount_type,discount_percent,discount_cents,max_discount_cents,buy_x,get_y,account_specific_user_id,category_id,min_order_cents,expires_at,max_uses,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [code, req.body.description || '', req.body.active === 'on', discountType, discountPercent, discountCents, maxDiscountCents, buyX, getY, accountId, categoryId, minOrderCents, expiresAt, maxUses, res.locals.user.id]);
    res.redirect('/staff/discount-codes');
  } catch (err) {
    console.error(err);
    res.redirect('/staff/discount-codes?error=' + encodeURIComponent('Rabattcode konnte nicht erstellt werden. Vielleicht existiert der Code schon.'));
  }
});
app.post('/staff/discount-codes/:id/toggle', requireOwner, async (req, res) => {
  await pool.query('UPDATE discount_codes SET active = NOT active WHERE id=$1', [req.params.id]);
  res.redirect('/staff/discount-codes');
});
app.post('/staff/discount-codes/:id/delete', requireOwner, async (req, res) => {
  await pool.query('DELETE FROM discount_codes WHERE id=$1', [req.params.id]);
  res.redirect('/staff/discount-codes');
});

app.get('/staff/customers', requireStaff, async (req, res) => {
  const type = req.query.type || 'customers';
  const where = type === 'premium' ? "WHERE role='premcustomer' OR premium=true" : type === 'staff' ? "WHERE role IN ('owner','staff')" : "WHERE role='customer' AND premium=false";
  const { rows } = await pool.query(`SELECT id,email,full_name,city,role,premium,delivered_order_count,created_at FROM users ${where} ORDER BY created_at DESC`);
  res.render('staff-customers', { title: 'Nutzer', customers: rows, type });
});
app.post('/staff/users/:id/role', requireOwner, async (req, res) => {
  const allowed = ['owner','staff','customer','premcustomer'];
  const role = allowed.includes(req.body.role) ? req.body.role : 'customer';
  const premium = role === 'premcustomer' || role === 'owner';
  await pool.query('UPDATE users SET role=$1, premium=$2 WHERE id=$3', [role, premium, req.params.id]);
  res.redirect('/staff/customers');
});


app.post('/staff/users/:id/reset-link', requireOwner, async (req, res) => {
  const user = (await pool.query('SELECT id,email,full_name,role FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!user) return res.status(404).send('Nutzer nicht gefunden');
  const token = await createPasswordReset(user.id, res.locals.user.id);
  await sendMail(user.email, 'Premium Shop: Passwort-Reset vom Owner', `<h2>Passwort zurücksetzen</h2><p>Hallo ${escapeHtml(user.full_name)},</p><p>Der Owner hat einen Passwort-Reset-Link für dich erstellt:</p><p><a href="${escapeHtml(resetUrl(token))}">${escapeHtml(resetUrl(token))}</a></p><p>Der Link ist 2 Stunden gültig.</p>`);
  res.redirect('/staff/customers?reset=sent');
});

app.get('/staff/profit', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN o.created_at >= date_trunc('day', now()) THEN (oi.unit_price_cents * (100-oi.discount_percent)/100 - oi.purchase_price_cents) * oi.quantity ELSE 0 END),0)::int AS day_profit,
      COALESCE(SUM(CASE WHEN o.created_at >= date_trunc('week', now()) THEN (oi.unit_price_cents * (100-oi.discount_percent)/100 - oi.purchase_price_cents) * oi.quantity ELSE 0 END),0)::int AS week_profit,
      COALESCE(SUM(CASE WHEN o.created_at >= date_trunc('month', now()) THEN (oi.unit_price_cents * (100-oi.discount_percent)/100 - oi.purchase_price_cents) * oi.quantity ELSE 0 END),0)::int AS month_profit,
      COALESCE(SUM((oi.unit_price_cents * (100-oi.discount_percent)/100 - oi.purchase_price_cents) * oi.quantity),0)::int AS total_profit,
      COALESCE(SUM((oi.unit_price_cents * (100-oi.discount_percent)/100) * oi.quantity),0)::int AS total_revenue,
      COALESCE(SUM(oi.purchase_price_cents * oi.quantity),0)::int AS total_cost
    FROM orders o
    JOIN order_items oi ON oi.order_id=o.id
    WHERE o.delivery_status='Delivered' AND o.status='Accepted'
  `);
  const items = await pool.query(`
    SELECT oi.product_name, COALESCE(oi.variant_name,'') AS variant_name, SUM(oi.quantity)::int AS qty,
      COALESCE(SUM((oi.unit_price_cents * (100-oi.discount_percent)/100) * oi.quantity),0)::int AS revenue,
      COALESCE(SUM(oi.purchase_price_cents * oi.quantity),0)::int AS cost,
      COALESCE(SUM((oi.unit_price_cents * (100-oi.discount_percent)/100 - oi.purchase_price_cents) * oi.quantity),0)::int AS profit
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.delivery_status='Delivered' AND o.status='Accepted'
    GROUP BY oi.product_name, oi.variant_name
    ORDER BY profit DESC
  `);
  res.render('staff-profit', { title: 'Profit', summary: rows[0], items: items.rows });
});

app.get('/bewertungen', async (_, res) => {
  const { rows } = await pool.query('SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 50');
  res.render('reviews', { title: 'Bewertungen', reviews: rows });
});

app.get('/health', (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Premium Shop läuft auf Port ${port}`));
