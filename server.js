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
const cloudinary = require('cloudinary').v2;
const PDFDocument = require('pdfkit');

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

const cloudinaryRequiredKeys = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];
const cloudinaryMissingKeys = cloudinaryRequiredKeys.filter((key) => !process.env[key]);
const cloudinaryConfigured = cloudinaryMissingKeys.length === 0;
const localImageFallbackEnabled = process.env.LOCAL_IMAGE_FALLBACK === 'true';

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

function cloudinaryPublicId(productId) {
  return `premium-shop/products/${productId}`;
}

const cloudinaryReviewFolder = String(process.env.CLOUDINARY_REVIEW_FOLDER || 'premium-shop/reviews').replace(/^\/+|\/+$/g, '');
function cloudinaryReviewPublicId(reviewKey) {
  return `${cloudinaryReviewFolder}/${reviewKey}`;
}

function uploadReviewImageToCloudinary(file, reviewKey) {
  return new Promise((resolve, reject) => {
    if (!cloudinaryConfigured) return reject(new Error(`Cloudinary ist nicht vollständig konfiguriert. Fehlende Render-Variablen: ${cloudinaryMissingKeys.join(', ')}`));
    const stream = cloudinary.uploader.upload_stream({
      public_id: cloudinaryReviewPublicId(reviewKey), resource_type: 'image', overwrite: true, invalidate: true,
      folder: undefined, use_filename: false, unique_filename: false
    }, (err, result) => err ? reject(err) : resolve(result));
    stream.end(file.buffer);
  });
}
async function storeReviewImage(file, reviewKey) {
  if (!file) return null;
  if (!cloudinaryConfigured) throw new Error(`Cloudinary ist nicht vollständig konfiguriert. Fehlende Render-Variablen: ${cloudinaryMissingKeys.join(', ')}`);
  const result = await uploadReviewImageToCloudinary(file, reviewKey);
  return result.secure_url;
}

function uploadToCloudinary(file, productId) {
  return new Promise((resolve, reject) => {
    if (!cloudinaryConfigured) {
      return reject(new Error(`Cloudinary ist nicht vollständig konfiguriert. Fehlende Render-Variablen: ${cloudinaryMissingKeys.join(', ')}. Deshalb wurde das Bild NICHT lokal gespeichert, weil lokale Render-Uploads bei Redeploys verschwinden würden.`));
    }

    const publicId = cloudinaryPublicId(productId);
    const stream = cloudinary.uploader.upload_stream({
      public_id: publicId,
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
      folder: undefined,
      use_filename: false,
      unique_filename: false
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });

    stream.end(file.buffer);
  });
}

async function storeProductImage(file, productId) {
  if (!file) return null;
  const ext = extensionFromFile(file);
  const fileName = `${productId}${ext}`;

  if (cloudinaryConfigured) {
    const result = await uploadToCloudinary(file, productId);
    console.log(`[Cloudinary] Produktbild gespeichert: ${fileName} (${result.public_id})`);
    return result.secure_url;
  }

  if (!localImageFallbackEnabled) {
    throw new Error(`Cloudinary ist nicht vollständig konfiguriert. Fehlende Render-Variablen: ${cloudinaryMissingKeys.join(', ')}. Deshalb wurde das Bild NICHT lokal gespeichert, weil lokale Render-Uploads bei Redeploys verschwinden würden.`);
  }

  console.warn('[WARN] LOCAL_IMAGE_FALLBACK=true aktiv. Produktbilder werden lokal gespeichert und können bei Render-Redeploys verschwinden.');
  for (const old of fs.readdirSync(localUploadDir)) {
    if (old.startsWith(`${productId}.`)) fs.rmSync(path.join(localUploadDir, old), { force: true });
  }
  fs.writeFileSync(path.join(localUploadDir, fileName), file.buffer);
  return `/public/uploads/${fileName}`;
}

async function deleteProductImage(productId) {
  if (cloudinaryConfigured) {
    try {
      const publicId = cloudinaryPublicId(productId);
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
      console.log(`[Cloudinary] Produktbild gelöscht: ${publicId}`);
    } catch (err) {
      console.error('[Cloudinary] Produktbild konnte nicht gelöscht werden:', err.message);
    }
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
const permissionKeys = [
  'can_manage_orders','can_manage_support','can_edit_products','can_edit_prices',
  'can_delete_products','can_manage_discounts','can_manage_users','can_ban_users',
  'can_manage_gift_cards','can_adjust_credit','can_verify_age','can_manage_meetings'
];
const permissionLabels = {
  can_manage_orders:'Bestellungen verwalten',
  can_manage_support:'Support bearbeiten',
  can_edit_products:'Produkte/Kategorien bearbeiten',
  can_edit_prices:'Preise, Einkaufspreise und Rabatte ändern',
  can_delete_products:'Produkte dauerhaft löschen',
  can_manage_discounts:'Rabattcodes verwalten',
  can_manage_users:'Nutzer und interne Notizen verwalten',
  can_ban_users:'Accounts sperren/entsperren',
  can_manage_gift_cards:'Gutscheinbestellungen bearbeiten',
  can_adjust_credit:'Guthaben manuell ändern',
  can_verify_age:'Altersstatus vergeben',
  can_manage_meetings:'Treffpunkte vorschlagen/bestätigen'
};
function ownerPermissions() { return Object.fromEntries(permissionKeys.map(k => [k, true])); }
function hasPermission(res, key) {
  return !!(res.locals.isOwner || (res.locals.staffPermissions && res.locals.staffPermissions[key]));
}
function requirePermission(key) {
  return (req, res, next) => {
    if (!res.locals.isStaff || !hasPermission(res, key)) return res.status(403).send('Dafür fehlt dir die Staff-Berechtigung.');
    next();
  };
}

const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
function identityKey(fullName, street, postalCode, city) {
  return [fullName, street, postalCode, city].map(v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
}
async function findBanFor({ email, ip, fullName, street, postalCode, city }) {
  const identity = identityKey(fullName, street, postalCode, city);
  const { rows } = await pool.query(`
    SELECT * FROM ban_rules
    WHERE active=true AND (
      (type='email' AND value=$1) OR
      (type='ip' AND value=$2) OR
      (type='identity' AND value=$3)
    )
    ORDER BY created_at DESC LIMIT 1
  `, [String(email || '').toLowerCase(), ip || '', identity]);
  return rows[0] || null;
}
function meetingUrl(orderId) { return orderUrl(orderId); }

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

const mailFrom = process.env.MAIL_FROM || process.env.MAILERSEND_FROM || `Premium Shop <${process.env.SMTP_USER || 'no-reply@example.com'}>`;
const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function parseMailFrom(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    return { name: m[1].trim().replace(/^"|"$/g, '') || 'Premium Shop', email: m[2].trim() };
  }
  return { name: 'Premium Shop', email: raw || 'no-reply@example.com' };
}

const mailersendConfigured = !!process.env.MAILERSEND_API_KEY;
const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function makeTransporter(port, secure) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    // Render kann manchmal IPv6-Adressen von smtp.gmail.com auflösen,
    // aber keine IPv6-Verbindung nach außen öffnen. family: 4 erzwingt IPv4.
    family: 4,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    requireTLS: !secure,
    tls: {
      servername: process.env.SMTP_HOST
    },
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function smtpTransportsToTry() {
  if (!smtpConfigured) return [];
  const configuredPort = Number(process.env.SMTP_PORT || 587);
  const configuredSecure = String(process.env.SMTP_SECURE || 'false') === 'true';
  const tries = [{ port: configuredPort, secure: configuredSecure }];
  if (!(configuredPort === 587 && configuredSecure === false)) tries.push({ port: 587, secure: false });
  if (!(configuredPort === 465 && configuredSecure === true)) tries.push({ port: 465, secure: true });
  return tries;
}

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

async function sendMailViaMailerSend(recipients, subject, html, text) {
  const from = parseMailFrom(mailFrom);
  const payload = {
    from,
    to: recipients.map(email => ({ email })),
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ' ')
  };
  const response = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MAILERSEND_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`MailerSend ${response.status}: ${body.slice(0, 1000)}`);
  }
  const id = response.headers.get('x-message-id') || 'ohne message id';
  console.log(`[Mail gesendet] ${subject} an ${recipients.join(', ')} via MailerSend (${id})`);
}

async function sendMailViaSmtp(recipients, subject, html, text) {
  let lastError = null;
  for (const cfg of smtpTransportsToTry()) {
    try {
      const transporter = makeTransporter(cfg.port, cfg.secure);
      await transporter.sendMail({
        from: mailFrom,
        to: recipients.join(','),
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, ' ')
      });
      console.log(`[Mail gesendet] ${subject} an ${recipients.join(', ')} via SMTP ${cfg.port}/${cfg.secure ? 'SSL' : 'STARTTLS'}`);
      return true;
    } catch (err) {
      lastError = err;
      console.error(`[Mail Fehler] SMTP ${cfg.port}/${cfg.secure ? 'SSL' : 'STARTTLS'}:`, err.message);
    }
  }
  if (lastError) throw lastError;
  return false;
}

async function sendMail(to, subject, html, text) {
  if (!to) {
    console.log('[Mail übersprungen] Empfänger fehlt:', subject);
    return;
  }
  const recipients = (Array.isArray(to) ? to : [to])
    .map(v => String(v || '').trim())
    .filter(Boolean);
  if (!recipients.length) return;

  if (mailersendConfigured) {
    try {
      await sendMailViaMailerSend(recipients, subject, html, text);
      return;
    } catch (err) {
      console.error('[Mail Fehler] MailerSend:', err.message);
      if (!smtpConfigured) return;
      console.error('[Mail Info] Versuche SMTP-Fallback...');
    }
  }

  if (smtpConfigured) {
    try {
      await sendMailViaSmtp(recipients, subject, html, text);
      return;
    } catch (err) {
      console.error('[Mail Fehler] Alle SMTP-Varianten fehlgeschlagen:', err.message || 'Unbekannter Fehler');
      return;
    }
  }

  console.log('[Mail übersprungen] Keine MailerSend- oder SMTP-Daten konfiguriert:', subject);
}

async function emailBanUpdate(user, reason, bannedNow) {
  if (!user?.email) return;
  if (bannedNow) {
    await sendMail(
      user.email,
      'Premium Shop: Konto gesperrt',
      `<h2>Konto gesperrt</h2><p>Hallo ${escapeHtml(user.full_name)},</p><p>dein Konto kann aktuell keine Bestellungen aufgeben.</p><p><b>Grund:</b> ${escapeHtml(reason || 'Nicht angegeben')}</p><p>Falls du glaubst, dass das ein Fehler ist, melde dich beim Premium Shop Team.</p>`,
      `Dein Konto kann aktuell keine Bestellungen aufgeben. Grund: ${reason || 'Nicht angegeben'}`
    );
  } else {
    await sendMail(
      user.email,
      'Premium Shop: Konto entsperrt',
      `<h2>Konto entsperrt</h2><p>Hallo ${escapeHtml(user.full_name)},</p><p>dein Konto wurde entsperrt. Du kannst wieder Bestellungen aufgeben.</p>`,
      'Dein Konto wurde entsperrt. Du kannst wieder Bestellungen aufgeben.'
    );
  }
}

async function emailDiscountCodeCreated(codeId) {
  const { rows } = await pool.query(`
    SELECT dc.*, c.name AS category_name, COALESCE(c.age_level,0)::int AS age_level, u.email AS target_email, u.full_name AS target_name
    FROM discount_codes dc
    LEFT JOIN categories c ON c.id=dc.category_id
    LEFT JOIN users u ON u.id=dc.account_specific_user_id
    WHERE dc.id=$1
  `, [codeId]);
  const dc = rows[0];
  if (!dc || !dc.active) return;
  let users;
  if (dc.account_specific_user_id) {
    users = (dc.target_email && !dc.target_email.endsWith('@example.com')) ? [{ email: dc.target_email, full_name: dc.target_name }] : [];
  } else {
    users = (await pool.query(`
      SELECT email, full_name FROM users
      WHERE role IN ('customer','premcustomer')
        AND COALESCE(banned,false)=false
        AND email IS NOT NULL AND email <> ''
      LIMIT 500
    `)).rows;
  }
  const recipients = [...new Set(users.map(u => String(u.email || '').trim()).filter(Boolean))];
  if (!recipients.length) return;

  const parts = [];
  if (dc.discount_type === 'percent') parts.push(`${dc.discount_percent}% Rabatt`);
  if (dc.discount_type === 'fixed') parts.push(`${money(dc.discount_cents)} Rabatt`);
  if (dc.buy_x && dc.get_y) parts.push(`Buy ${dc.buy_x}, get ${dc.get_y}`);
  if (dc.max_discount_cents != null) parts.push(`max. ${money(dc.max_discount_cents)} Rabatt`);
  if (dc.min_order_cents) parts.push(`ab ${money(dc.min_order_cents)} Einkaufswert`);
  if (dc.category_name) parts.push(`Kategorie: ${dc.category_name}`);
  if (dc.expires_at) parts.push(`gültig bis ${new Date(dc.expires_at).toLocaleString('de-DE')}`);
  const list = parts.length ? `<ul>${parts.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : '';
  await sendMail(
    recipients,
    `Premium Shop: Neuer Rabattcode ${dc.code}`,
    `<h2>Neuer Rabattcode</h2><p>Es gibt einen neuen Rabattcode:</p><p style="font-size:24px"><b>${escapeHtml(dc.code)}</b></p>${list}<p>${escapeHtml(dc.description || '')}</p><p><a href="${escapeHtml(appUrl || '/')}">Zum Shop</a></p>`,
    `Neuer Rabattcode: ${dc.code}. ${parts.join(', ')} ${dc.description || ''}`
  );
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


async function emailMeetingUpdate(orderId) {
  const { rows } = await pool.query('SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [orderId]);
  const order = rows[0];
  if (!order) return;
  await sendMail(
    order.email,
    'Premium Shop: Treffpunkt zur Bestellung aktualisiert',
    `<h2>Treffpunkt aktualisiert</h2><p>Hallo ${escapeHtml(order.full_name)},</p><p>Deine Bestellung hat neue Treffpunkt-Informationen:</p><ul><li><b>Ort:</b> ${escapeHtml(order.meeting_location || '-')}</li><li><b>Zeit:</b> ${order.meeting_at ? escapeHtml(new Date(order.meeting_at).toLocaleString('de-DE')) : '-'}</li><li><b>Hinweis:</b> ${escapeHtml(order.meeting_note || '-')}</li></ul><p><a href="${escapeHtml(orderUrl(order.id))}">Bestellung öffnen</a></p>`,
    `Treffpunkt: ${order.meeting_location || '-'} / ${order.meeting_at ? new Date(order.meeting_at).toLocaleString('de-DE') : '-'} / ${order.meeting_note || ''} ${orderUrl(order.id)}`
  );
}

async function currentUser(req, res, next) {
  res.locals.user = null;
  res.locals.cartCount = 0;
  res.locals.notifications = 0;
  res.locals.staffActionCount = 0;
  res.locals.money = money;
  res.locals.discounted = discounted;
  res.locals.roleLabel = roleLabel;
  res.locals.verificationLabel = verificationLabel;
  res.locals.ageRestrictionEnabled = false;
  res.locals.staffPermissions = {};
  res.locals.permissionLabels = permissionLabels;
  res.locals.hasPermission = key => hasPermission(res, key);
  res.locals.creditCents = 0;
  res.locals.supportActionCount = 0;
  res.locals.isStaff = false;
  res.locals.isOwner = false;
  res.locals.isCustomer = false;
  res.locals.originalUrl = req.originalUrl;
  res.locals.ageRestrictionEnabled = await isAgeRestrictionEnabled();
  if (req.session.userId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    res.locals.user = rows[0] || null;
    if (res.locals.user) {
      res.locals.isStaff = staffRoles.includes(res.locals.user.role);
      res.locals.isOwner = res.locals.user.role === 'owner';
      res.locals.isCustomer = customerRoles.includes(res.locals.user.role);
      res.locals.creditCents = Math.max(0, Number(res.locals.user.credit_cents || 0));
      if (res.locals.isOwner) {
        res.locals.staffPermissions = ownerPermissions();
      } else if (res.locals.user.role === 'staff') {
        await pool.query('INSERT INTO staff_permissions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [res.locals.user.id]);
        const permQ = await pool.query('SELECT * FROM staff_permissions WHERE user_id=$1', [res.locals.user.id]);
        res.locals.staffPermissions = permQ.rows[0] || {};
      }
      const cc = await pool.query('SELECT COALESCE(SUM(quantity),0)::int AS count FROM carts WHERE user_id=$1', [res.locals.user.id]);
      res.locals.cartCount = cc.rows[0].count;
      const nn = await pool.query(`
        SELECT COUNT(*)::int AS count FROM orders o
        WHERE o.user_id=$1 AND (o.customer_seen_at IS NULL OR o.updated_at > o.customer_seen_at
          OR EXISTS (SELECT 1 FROM messages m WHERE m.order_id=o.id AND m.sender_id<>$1 AND (o.customer_seen_at IS NULL OR m.created_at > o.customer_seen_at)))
      `, [res.locals.user.id]);
      res.locals.notifications = nn.rows[0].count;
      if (staffRoles.includes(res.locals.user.role)) {
        const sq = res.locals.user.role === 'owner'
          ? await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status='Placed' AND delivery_status <> 'Delivered' AND archived_by_staff=false")
          : await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status='Placed' AND delivery_status <> 'Delivered' AND archived_by_staff=false AND assigned_staff_id=$1", [res.locals.user.id]);
        res.locals.staffActionCount = sq.rows[0].count;
        if (hasPermission(res, 'can_manage_support')) {
          const supportQ = res.locals.isOwner
            ? await pool.query("SELECT COUNT(*)::int AS count FROM support_conversations WHERE status <> 'closed'")
            : await pool.query("SELECT COUNT(*)::int AS count FROM support_conversations WHERE status <> 'closed' AND assigned_staff_id=$1", [res.locals.user.id]);
          res.locals.supportActionCount = supportQ.rows[0].count;
        }
      }
    }
  }
  next();
}
app.use(currentUser);

function requireLogin(req, res, next) { if (!res.locals.user) return res.redirect('/login'); next(); }
function requireStaff(req, res, next) { if (!res.locals.isStaff) return res.status(403).send('Kein Zugriff'); next(); }
function requireOwner(req, res, next) { if (!res.locals.isOwner) return res.status(403).send('Nur Owner dürfen Rollen ändern.'); next(); }
function requireCustomer(req, res, next) { if (!res.locals.isCustomer) return res.status(403).send('Nur Kunden können das machen.'); next(); }
function requireOrderPermissionForStaff(req, res, next) { if (res.locals.isStaff && !hasPermission(res, 'can_manage_orders')) return res.status(403).send('Dafür fehlt dir die Bestell-Berechtigung.'); next(); }

async function attachVariants(products) {
  if (!products.length) return products;
  const ids = products.map(p => p.id);
  const { rows } = await pool.query('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY name', [ids]);
  const byProduct = {};
  rows.forEach(v => { (byProduct[v.product_id] ||= []).push(v); });
  return products.map(p => ({ ...p, variants: byProduct[p.id] || [] }));
}

function productSortSql(sort) {
  return {
    'price_asc': 'p.price_cents ASC, p.name ASC',
    'price_desc': 'p.price_cents DESC, p.name ASC',
    'name_asc': 'p.name ASC',
    'name_desc': 'p.name DESC',
    'views_desc': 'p.views_count DESC, p.name ASC',
    'sold_desc': 'sold_count DESC, p.name ASC',
    'created_desc': 'p.created_at DESC'
  }[sort] || 'p.created_at DESC';
}

function productRedirect(req, productId) {
  const returnTo = String(req.body.return_to || req.get('referer') || '/staff/products').split('#')[0] || '/staff/products';
  return returnTo + (productId ? `#produkt-${productId}` : '');
}

async function getDefaultCategoryId(db = pool) {
  const { rows } = await db.query(`
    INSERT INTO categories (name, description, active)
    VALUES ('Allgemein', 'Automatisch erstellte Standard-Kategorie', true)
    ON CONFLICT (name) DO UPDATE SET active=true
    RETURNING id
  `);
  return rows[0].id;
}

async function categoryOrDefault(categoryId, db = pool) {
  return categoryId || await getDefaultCategoryId(db);
}

function isUuidValue(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
function requireUuidParam(req, res, next) {
  if (!isUuidValue(req.params.id)) return res.status(404).send('Nicht gefunden');
  next();
}

function safeStockInt(value, fallback = 0) {
  const n = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

async function syncProductStock(clientOrPool, productId) {
  const { rows } = await clientOrPool.query(
    'SELECT COUNT(*)::int AS count, COALESCE(SUM(stock),0)::int AS stock FROM product_variants WHERE product_id=$1 AND active=true',
    [productId]
  );
  if (rows[0] && rows[0].count > 0) {
    await clientOrPool.query('UPDATE products SET stock=$1 WHERE id=$2', [safeStockInt(rows[0].stock), productId]);
  } else {
    await clientOrPool.query('UPDATE products SET stock=GREATEST(COALESCE(stock,0),0) WHERE id=$1', [productId]);
  }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

function compactText(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVariantName(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9äöüß%.,+-]/gi, '');
}

function hasHiddenClass(classValue) {
  return /(^|\s)hidden(\s|$)/i.test(String(classValue || ''));
}

function visibleTextFlag(raw, classNeedle, textPattern) {
  const regex = new RegExp(`<([a-z0-9]+)\\b([^>]*)class=["']([^"']*${classNeedle}[^"']*)["']([^>]*)>([\\s\\S]*?)<\\/\\1>`, 'ig');
  let match;
  while ((match = regex.exec(raw))) {
    const cls = match[3] || '';
    if (hasHiddenClass(cls)) continue;
    const text = compactText(match[5]);
    if (textPattern.test(text)) return true;
  }
  return false;
}

function extractJsonLdAvailability(raw) {
  const scripts = [...String(raw || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig)].map(m => m[1]);
  const found = { availability: '', quantity: null };
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.availability && !found.availability) found.availability = String(obj.availability);
    if ((obj.inventoryLevel || obj.quantity || obj.stock) && found.quantity === null) {
      const q = obj.inventoryLevel?.value ?? obj.inventoryLevel ?? obj.quantity ?? obj.stock;
      const n = safeStockInt(q, null);
      if (n !== null) found.quantity = n;
    }
    if (Array.isArray(obj)) obj.forEach(walk);
    else Object.values(obj).forEach(walk);
  }
  for (const script of scripts) {
    try { walk(JSON.parse(script.replace(/&quot;/g, '"'))); } catch (_) {}
  }
  return found;
}

function parseSupplierVariants(raw) {
  const variants = [];
  const labelRegex = /<label\b([^>]*)class=["']([^"']*select-variant[^"']*)["']([^>]*)>([\s\S]*?)<\/label>/ig;
  let match;
  while ((match = labelRegex.exec(raw))) {
    const attrs = `${match[1] || ''} ${match[3] || ''}`;
    const cls = match[2] || '';
    const body = match[4] || '';
    const id = (attrs.match(/id=["']([^"']+)["']/i) || [])[1] || '';
    const title = (attrs.match(/title=["']([^"']+)["']/i) || [])[1] || '';
    const stockMatch = body.match(/<span\b[^>]*class=["'][^"']*stockcounter[^"']*["'][^>]*>\s*(\d+)x\s*<\/span>/i);
    const stock = stockMatch ? safeStockInt(stockMatch[1], null) : null;
    const nameMatch = [...body.matchAll(/<span\b(?![^>]*stockcounter)[^>]*>([\s\S]*?)<\/span>/ig)].map(m => compactText(m[1])).find(Boolean);
    const name = nameMatch || compactText(title).replace(/^Wähle\s+ein\s*/i, '') || id;
    const out = /(^|\s)outOfStock(\s|$)/i.test(cls) || /notonstock/i.test(body) || stock === 0;
    const selected = /(^|\s)selected(\s|$)/i.test(cls);
    variants.push({ id, name, stock, out, selected });
  }
  return variants;
}

function parseSupplierAvailability(html) {
  const raw = String(html || '');
  const jsonLd = extractJsonLdAvailability(raw);

  const qtyMatch = firstMatch(raw, [
    /<meta\b[^>]*itemprop=["']quantity["'][^>]*content=["'](\d+)["'][^>]*>/i,
    /<meta\b[^>]*content=["'](\d+)["'][^>]*itemprop=["']quantity["'][^>]*>/i
  ]);
  const metaQty = qtyMatch ? safeStockInt(qtyMatch[1], null) : null;

  const availabilityMatch = firstMatch(raw, [
    /<meta\b[^>]*itemprop=["']availability["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*itemprop=["']availability["'][^>]*>/i,
    /"availability"\s*:\s*"([^"]+)"/i
  ]);
  const availabilityRaw = availabilityMatch ? String(availabilityMatch[1]) : (jsonLd.availability || '');
  const availability = availabilityRaw.toLowerCase();

  const supplierVariants = parseSupplierVariants(raw);
  const selectedVariant = supplierVariants.find(v => v.selected) || null;
  const availableVariantStocks = supplierVariants.filter(v => !v.out && v.stock !== null).map(v => v.stock);

  let detectedStock = null;
  let source = 'unbekannt';
  if (selectedVariant && selectedVariant.stock !== null) {
    detectedStock = selectedVariant.stock;
    source = `gewählte Händler-Variante ${selectedVariant.name}`;
  } else if (metaQty !== null) {
    detectedStock = metaQty;
    source = 'meta quantity';
  } else if (jsonLd.quantity !== null) {
    detectedStock = jsonLd.quantity;
    source = 'json-ld quantity';
  } else if (availableVariantStocks.length) {
    detectedStock = availableVariantStocks.reduce((a, b) => a + b, 0);
    source = 'Summe Händler-Varianten';
  }

  const visibleOut = visibleTextFlag(raw, 'out-of-stock', /^Nicht\s+auf\s+Lager$/i);
  const visibleIn = visibleTextFlag(raw, 'in-stock', /^Auf\s+Lager$/i);
  const selectedOut = selectedVariant ? selectedVariant.out : false;

  const saysOut = selectedOut || /out[_-]?of[_-]?stock/i.test(availability) || /schema\.org\/outofstock/i.test(availability) || visibleOut || detectedStock === 0;
  const saysIn = /in[_-]?stock/i.test(availability) || /schema\.org\/instock/i.test(availability) || visibleIn || (detectedStock !== null && detectedStock > 0);

  if (saysOut && !saysIn) {
    return { status: 'out_of_stock', note: `Nicht auf Lager (${source}${detectedStock !== null ? ': ' + detectedStock : ''})`, stock: 0, source, variants: supplierVariants, selectedVariant };
  }
  if (saysIn && !selectedOut) {
    return { status: 'in_stock', note: detectedStock !== null ? `Lager: ${detectedStock} (${source})` : 'Auf Lager', stock: detectedStock, source, variants: supplierVariants, selectedVariant };
  }
  if (detectedStock !== null) {
    return detectedStock > 0
      ? { status: 'in_stock', note: `Lager: ${detectedStock} (${source})`, stock: detectedStock, source, variants: supplierVariants, selectedVariant }
      : { status: 'out_of_stock', note: `Nicht auf Lager (${source}: 0)`, stock: 0, source, variants: supplierVariants, selectedVariant };
  }

  return { status: 'unknown', note: 'Konnte Lagerstatus nicht sicher erkennen', stock: null, source, variants: supplierVariants, selectedVariant };
}

function normalizeSupplierUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw;
}

async function applySupplierStockToProduct(product, result) {
  const variants = await pool.query('SELECT id,name FROM product_variants WHERE product_id=$1 AND active=true ORDER BY name', [product.id]);

  if (result.status === 'out_of_stock') {
    await pool.query('UPDATE products SET stock=0 WHERE id=$1', [product.id]);
    await pool.query('UPDATE product_variants SET stock=0 WHERE product_id=$1', [product.id]);
    await syncProductStock(pool, product.id);
    return 'alle lokalen Bestände auf 0 gesetzt';
  }

  if (result.status !== 'in_stock' || result.stock === null || result.stock === undefined) {
    return 'kein Bestand geändert';
  }

  const stock = safeStockInt(result.stock, 0);

  if (!variants.rows.length) {
    await pool.query('UPDATE products SET stock=$1 WHERE id=$2', [stock, product.id]);
    return `Produktbestand auf ${stock} gesetzt`;
  }

  if (variants.rows.length === 1) {
    await pool.query('UPDATE product_variants SET stock=$1 WHERE id=$2', [stock, variants.rows[0].id]);
    await syncProductStock(pool, product.id);
    return `eine lokale Sorte auf ${stock} gesetzt`;
  }

  let updated = 0;
  const supplierVariants = Array.isArray(result.variants) ? result.variants : [];
  for (const local of variants.rows) {
    const localKey = normalizeVariantName(local.name);
    const supplier = supplierVariants.find(v => normalizeVariantName(v.name) === localKey);
    if (!supplier || supplier.stock === null || supplier.stock === undefined) continue;
    await pool.query('UPDATE product_variants SET stock=$1 WHERE id=$2', [supplier.out ? 0 : safeStockInt(supplier.stock, 0), local.id]);
    updated++;
  }

  if (updated > 0) {
    await syncProductStock(pool, product.id);
    return `${updated} lokale Sorten per Händlername aktualisiert`;
  }

  return `Bestand erkannt (${stock}), aber lokale Sorten passen nicht eindeutig zum Händler. Sorten manuell zuordnen/gleichen Namen nutzen.`;
}

async function checkSupplierStatus(product, { force=false } = {}) {
  if (!product || !product.supplier_url) return null;
  if (!force && product.supplier_checked_at) {
    const ageMs = Date.now() - new Date(product.supplier_checked_at).getTime();
    if (ageMs < 10 * 60 * 1000) return { status: product.supplier_status || 'unknown', note: product.supplier_status_note || 'Kürzlich geprüft', skipped: true };
  }

  let result = { status: 'unknown', note: 'Konnte Händlerseite nicht laden', stock: null };
  try {
    const url = normalizeSupplierUrl(product.supplier_url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    const parsedUrl = new URL(url);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'referer': `${parsedUrl.protocol}//${parsedUrl.host}/`
      }
    });
    clearTimeout(timeout);

    const html = await response.text();
    if (!response.ok) {
      result = { status: 'unknown', note: `HTTP ${response.status} vom Händler (${html.length} Zeichen)`, stock: null };
    } else if (!html || html.length < 500) {
      result = { status: 'unknown', note: `Händlerantwort zu kurz (${html.length} Zeichen)`, stock: null };
    } else {
      result = parseSupplierAvailability(html);
      const applied = await applySupplierStockToProduct(product, result);
      result.note = `${result.note} · ${applied}`;
    }
  } catch (err) {
    result = { status: 'unknown', note: err.name === 'AbortError' ? 'Timeout beim Händlercheck' : err.message, stock: null };
  }

  await pool.query('UPDATE products SET supplier_status=$1, supplier_status_note=$2, supplier_checked_at=now() WHERE id=$3', [result.status, result.note, product.id]);
  return result;
}

async function getAppSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
    return rows[0]?.value || null;
  } catch (err) {
    console.error('[Settings] konnte nicht gelesen werden:', err.message);
    return null;
  }
}

async function setAppSetting(key, value) {
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, value]
    );
  } catch (err) {
    console.error('[Settings] konnte nicht gespeichert werden:', err.message);
  }
}

let supplierAutoCheckInProgress = false;
async function checkAllSupplierStatuses({ force = true } = {}) {
  const { rows } = await pool.query("SELECT * FROM products WHERE COALESCE(TRIM(supplier_url),'') <> '' AND active=true ORDER BY name");
  let checked = 0;
  for (const product of rows) {
    try {
      await checkSupplierStatus(product, { force });
      checked++;
    } catch (err) {
      console.error('[Händlercheck]', product.id, err.message);
    }
  }
  return checked;
}

async function triggerHomepageSupplierCheckIfDue() {
  const key = 'supplier_auto_check_last_at';
  const last = await getAppSetting(key);
  const lastMs = last ? new Date(last).getTime() : 0;
  const tenMinutes = 10 * 60 * 1000;
  if (supplierAutoCheckInProgress) return false;
  if (lastMs && Date.now() - lastMs < tenMinutes) return false;

  // Cooldown sofort setzen, damit mehrere Besucher nicht gleichzeitig alle Händlerseiten abrufen.
  await setAppSetting(key, new Date().toISOString());
  supplierAutoCheckInProgress = true;
  checkAllSupplierStatuses({ force: true })
    .then(count => console.log(`[Händlercheck] Auto-Check Homepage fertig: ${count} Produkte geprüft.`))
    .catch(err => console.error('[Händlercheck] Auto-Check Homepage Fehler:', err.message))
    .finally(() => { supplierAutoCheckInProgress = false; });
  return true;
}



async function isAgeRestrictionEnabled() {
  return (await getAppSetting('age_restriction_enabled')) === 'true';
}

async function registrationCodeSettings() {
  const enabled = (await getAppSetting('registration_code_enabled')) === 'true' && await isAgeRestrictionEnabled();
  const code = String(await getAppSetting('registration_code') || '').trim();
  return { enabled, code };
}

function verificationLabel(level) {
  const n = parseInt(level || 0, 10);
  return n === 18 ? '18+' : n === 16 ? '16+' : 'Unverified';
}

async function logAudit(req, action, targetType='', targetId='', details='') {
  try {
    const actorId = resIdFromReq(req);
    await pool.query('INSERT INTO audit_logs (actor_id,action,target_type,target_id,details,ip) VALUES ($1,$2,$3,$4,$5,$6)', [actorId, action, targetType, String(targetId || ''), String(details || '').slice(0, 3000), clientIp(req)]);
  } catch (err) { console.error('[Audit] Fehler:', err.message); }
}
function resIdFromReq(req) { return req.session?.userId || null; }

async function addOrderEvent(orderId, actorId, eventType, note='') {
  try { await pool.query('INSERT INTO order_events (order_id,actor_id,event_type,note) VALUES ($1,$2,$3,$4)', [orderId, actorId || null, eventType, String(note || '').slice(0, 1000)]); }
  catch (err) { console.error('[OrderEvent] Fehler:', err.message); }
}

async function emailStaffAssignment(orderId, staffId) {
  const { rows } = await pool.query('SELECT o.*, u.full_name AS customer_name, s.email AS staff_email, s.full_name AS staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=$2 WHERE o.id=$1', [orderId, staffId]);
  const o = rows[0];
  if (!o || !o.staff_email) return;
  await sendMail(o.staff_email, 'Premium Shop: Bestellung wurde dir zugeteilt', `<h2>Neue Zuteilung</h2><p>Hallo ${escapeHtml(o.staff_name)},</p><p>dir wurde eine Bestellung von <b>${escapeHtml(o.customer_name)}</b> zugeteilt.</p><p><a href="${escapeHtml(orderUrl(orderId))}">Bestellung öffnen</a></p>`, `Dir wurde eine Bestellung zugeteilt: ${orderUrl(orderId)}`);
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

async function chooseSupportStaff(db=pool) {
  const { rows } = await db.query(`
    SELECT u.id, COUNT(sc.id)::int AS open_count
    FROM users u
    LEFT JOIN staff_permissions sp ON sp.user_id=u.id
    LEFT JOIN support_conversations sc ON sc.assigned_staff_id=u.id AND sc.status <> 'closed'
    WHERE u.role='owner' OR (u.role='staff' AND COALESCE(sp.can_manage_support,true)=true)
    GROUP BY u.id
    ORDER BY open_count ASC, CASE WHEN u.role='staff' THEN 0 ELSE 1 END, random()
    LIMIT 1
  `);
  return rows[0]?.id || null;
}

async function chooseGiftCardStaff(db=pool) {
  const { rows } = await db.query(`
    SELECT u.id, COUNT(gco.id)::int AS open_count
    FROM users u
    LEFT JOIN staff_permissions sp ON sp.user_id=u.id
    LEFT JOIN gift_card_orders gco ON gco.assigned_staff_id=u.id AND gco.status='requested'
    WHERE u.role='owner' OR (u.role='staff' AND COALESCE(sp.can_manage_gift_cards,true)=true)
    GROUP BY u.id
    ORDER BY open_count ASC, CASE WHEN u.role='staff' THEN 0 ELSE 1 END, random()
    LIMIT 1
  `);
  return rows[0]?.id || null;
}

function giftCardCode() {
  const raw = crypto.randomBytes(9).toString('hex').toUpperCase();
  return `PREM-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;
}
function giftCardPdfUrl(card) {
  const base = appUrl || '';
  return `${base}/gift-cards/${card.id}/pdf?token=${encodeURIComponent(card.download_token)}`;
}

async function emailSupportAssignment(conversationId, staffId) {
  const { rows } = await pool.query(`SELECT sc.*, u.full_name AS customer_name, s.email AS staff_email, s.full_name AS staff_name
    FROM support_conversations sc JOIN users u ON u.id=sc.user_id LEFT JOIN users s ON s.id=$2 WHERE sc.id=$1`, [conversationId, staffId]);
  const c = rows[0];
  if (!c?.staff_email) return;
  await sendMail(c.staff_email, `Premium Shop Support #${c.conversation_no}`, `<h2>Neue Support-Konversation</h2><p>Hallo ${escapeHtml(c.staff_name)},</p><p><b>${escapeHtml(c.customer_name)}</b> braucht Hilfe: ${escapeHtml(c.subject || c.category)}</p><p><a href="${escapeHtml((appUrl || '') + '/staff/support/' + c.id)}">Konversation öffnen</a></p>`);
}

async function emailSupportCustomerMessage(conversationId, message) {
  const { rows } = await pool.query(`
    SELECT sc.conversation_no, sc.subject, sc.assigned_staff_id, u.full_name AS customer_name
    FROM support_conversations sc JOIN users u ON u.id=sc.user_id WHERE sc.id=$1
  `, [conversationId]);
  const c = rows[0];
  if (!c) return;
  const recipientsQ = c.assigned_staff_id
    ? await pool.query('SELECT email FROM users WHERE id=$1 AND email IS NOT NULL', [c.assigned_staff_id])
    : await pool.query("SELECT email FROM users WHERE role='owner' AND email IS NOT NULL");
  const recipients = recipientsQ.rows.map(r => r.email).filter(Boolean);
  if (!recipients.length) return;
  await sendMail(recipients, `Premium Shop Support #${c.conversation_no}: Neue Kundennachricht`, `<h2>Neue Support-Nachricht</h2><p><b>${escapeHtml(c.customer_name)}</b> hat geschrieben:</p><blockquote>${escapeHtml(String(message || '').slice(0,1000))}</blockquote><p><a href="${escapeHtml((appUrl || '') + '/staff/support/' + conversationId)}">Conversation öffnen</a></p>`);
}

async function emailMeetingCustomerResponse(orderId, label, note='') {
  const { rows } = await pool.query(`SELECT o.assigned_staff_id, o.customer_name_snapshot, u.full_name AS current_name
    FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1`, [orderId]);
  const o = rows[0];
  if (!o) return;
  const recipientsQ = o.assigned_staff_id
    ? await pool.query('SELECT email FROM users WHERE id=$1 AND email IS NOT NULL', [o.assigned_staff_id])
    : await pool.query("SELECT email FROM users WHERE role='owner' AND email IS NOT NULL");
  const recipients = recipientsQ.rows.map(r => r.email).filter(Boolean);
  if (!recipients.length) return;
  const customerName = o.customer_name_snapshot || o.current_name || 'Kunde';
  await sendMail(recipients, `Premium Shop: Treffpunkt-Antwort von ${customerName}`, `<h2>Treffpunkt-Antwort</h2><p><b>${escapeHtml(customerName)}</b>: ${escapeHtml(label)}</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}<p><a href="${escapeHtml(orderUrl(orderId))}">Bestellung öffnen</a></p>`);
}

async function emailGiftCardRequest(orderId, staffId) {
  const { rows } = await pool.query(`SELECT gco.*, u.full_name AS customer_name, s.email AS staff_email, s.full_name AS staff_name FROM gift_card_orders gco JOIN users u ON u.id=gco.user_id LEFT JOIN users s ON s.id=$2 WHERE gco.id=$1`, [orderId, staffId]);
  const g = rows[0];
  if (!g?.staff_email) return;
  await sendMail(g.staff_email, 'Premium Shop: Neue Gutschein-Anfrage', `<h2>Neue Gutschein-Anfrage</h2><p>Hallo ${escapeHtml(g.staff_name)},</p><p>${escapeHtml(g.customer_name)} möchte einen Gutschein über <b>${escapeHtml(money(g.amount_cents))}</b> kaufen.</p><p><a href="${escapeHtml((appUrl || '') + '/staff/gift-cards')}">Anfrage öffnen</a></p>`);
}

async function emailGiftCardReady(cardId) {
  const { rows } = await pool.query(`SELECT gc.*, gco.user_id, u.email, u.full_name FROM gift_cards gc JOIN gift_card_orders gco ON gco.id=gc.gift_card_order_id JOIN users u ON u.id=gco.user_id WHERE gc.id=$1`, [cardId]);
  const card = rows[0];
  if (!card) return;
  await sendMail(card.email, 'Premium Shop: Dein Gutschein ist bereit', `<h2>Dein Gutschein ist bereit</h2><p>Hallo ${escapeHtml(card.full_name)},</p><p>Wert: <b>${escapeHtml(money(card.value_cents))}</b></p><p>Code: <b>${escapeHtml(card.code)}</b></p><p><a href="${escapeHtml(giftCardPdfUrl(card))}">Geschenkkarte als PDF herunterladen</a></p><p>Der Code kann unter „Mein Konto“ eingelöst werden.</p>`, `Gutschein ${card.code} im Wert von ${money(card.value_cents)}. PDF: ${giftCardPdfUrl(card)}`);
}

function streamGiftCardPdf(res, card) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Premium Shop Geschenkkarte' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Premium-Shop-Gutschein-${card.code}.pdf"`);
  doc.pipe(res);
  doc.rect(0,0,595.28,841.89).fill('#f3f6fb');
  doc.roundedRect(48,150,499,430,24).fillAndStroke('#ffffff','#173f7a');
  doc.rect(48,150,499,86).fill('#173f7a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28).text('PREMIUM SHOP',72,180,{width:450,align:'center'});
  doc.fillColor('#173f7a').font('Helvetica-Bold').fontSize(26).text('Geschenkkarte',72,275,{width:450,align:'center'});
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(44).text(money(card.value_cents),72,330,{width:450,align:'center'});
  doc.fillColor('#475569').font('Helvetica').fontSize(13).text('Gutscheincode',72,405,{width:450,align:'center'});
  doc.fillColor('#111827').font('Courier-Bold').fontSize(22).text(card.code,72,430,{width:450,align:'center',characterSpacing:1});
  if (card.custom_message) {
    doc.fillColor('#334155').font('Helvetica-Oblique').fontSize(14).text(card.custom_message,95,485,{width:405,align:'center',height:60,ellipsis:true});
  }
  doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Einlösbar im Bereich „Mein Konto“. Der Code ist nur einmal verwendbar.',72,550,{width:450,align:'center'});
  doc.fillColor('#64748b').fontSize(9).text(`Erstellt am ${new Date(card.created_at).toLocaleDateString('de-DE')}`,72,760,{width:450,align:'center'});
  doc.end();
}

async function refundOrderCredit(db, order, note='Guthaben-Rückerstattung') {
  if (!order || !order.credit_used_cents || order.credit_refunded_at) return 0;
  const amount = Math.max(0, Number(order.credit_used_cents));
  if (!amount) return 0;
  await db.query('UPDATE users SET credit_cents=credit_cents+$1 WHERE id=$2', [amount, order.user_id]);
  await db.query(`INSERT INTO credit_transactions (user_id,amount_cents,transaction_type,reference_type,reference_id,note,created_by)
    VALUES ($1,$2,'refund','order',$3,$4,$5)`, [order.user_id, amount, order.id, note, null]);
  await db.query(`UPDATE orders SET credit_refunded_at=now(), credit_used_cents=0, total_cents=original_total_cents, payment_method=CASE WHEN payment_method='Guthaben' THEN 'Vorauszahlung' ELSE payment_method END, payment_status=CASE WHEN payment_method='Guthaben' THEN 'Unpaid' ELSE payment_status END WHERE id=$1`, [order.id]);
  return amount;
}

async function recalculateOrderTotals(db, orderId, actorId=null) {
  const orderQ = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  const order = orderQ.rows[0];
  if (!order) return null;
  const sumQ = await db.query(`SELECT COALESCE(SUM(ROUND(unit_price_cents*(100-discount_percent)/100.0)*quantity),0)::int AS item_total FROM order_items WHERE order_id=$1`, [orderId]);
  const original = Math.max(0, Number(sumQ.rows[0].item_total || 0) - Number(order.discount_cents || 0));
  let used = Math.min(Math.max(0, Number(order.credit_used_cents || 0)), original);
  const refund = Math.max(0, Number(order.credit_used_cents || 0) - used);
  if (refund > 0) {
    await db.query('UPDATE users SET credit_cents=credit_cents+$1 WHERE id=$2', [refund, order.user_id]);
    await db.query(`INSERT INTO credit_transactions (user_id,amount_cents,transaction_type,reference_type,reference_id,note,created_by)
      VALUES ($1,$2,'refund','order',$3,'Guthaben wegen Bestelländerung zurückerstattet',$4)`, [order.user_id, refund, order.id, actorId]);
  }
  const remaining = Math.max(0, original - used);
  let paymentMethod = order.payment_method;
  let paymentStatus = order.payment_status;
  if (remaining === 0) { paymentMethod='Guthaben'; paymentStatus='Paid'; }
  else if (paymentMethod === 'Guthaben') { paymentMethod='Vorauszahlung'; paymentStatus='Unpaid'; }
  else if (paymentMethod === 'Bei Lieferung') paymentStatus='Pay on delivery';
  await db.query('UPDATE orders SET original_total_cents=$1,credit_used_cents=$2,total_cents=$3,payment_method=$4,payment_status=$5,updated_at=now() WHERE id=$6', [original,used,remaining,paymentMethod,paymentStatus,orderId]);
  return { original, used, remaining, refund };
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
  const { rows } = await db.query(`SELECT c.id AS cart_id, c.quantity, c.variant_id, p.*, COALESCE(cat.age_level,0)::int AS age_level, v.name AS variant_name, COALESCE(v.stock, p.stock) AS stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN categories cat ON cat.id=p.category_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 ORDER BY p.name, v.name`, [userId]);
  return rows;
}

app.get('/', async (req, res) => {
  await triggerHomepageSupplierCheckIfDue();
  const categoryId = req.query.kategorie || '';
  const sort = req.query.sort || 'created_desc';
  const categories = await pool.query('SELECT * FROM categories WHERE active=true ORDER BY name');
  const orderBy = productSortSql(sort);

  const baseProductSql = `
    SELECT
      p.id, p.name, p.description, p.price_cents, p.discount_percent,
      p.stock, p.image_url, p.active, p.category_id, p.created_at, p.views_count,
      p.supplier_status, p.supplier_checked_at,
      c.name AS category_name, COALESCE(c.age_level,0)::int AS age_level,
      COALESCE((SELECT SUM(v.stock) FROM product_variants v WHERE v.product_id = p.id), p.stock)::int AS display_stock,
      COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.product_id=p.id),0)::int AS sold_count
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = true
  `;

  const products = categoryId
    ? await pool.query(baseProductSql + ` AND p.category_id = $1 ORDER BY ${orderBy}`, [categoryId])
    : await pool.query(baseProductSql + ` ORDER BY ${orderBy}`);

  const productsWithVariants = await attachVariants(products.rows);
  res.render('shop', { title: 'Shop', products: productsWithVariants, categories: categories.rows, selectedCategory: categoryId, sort });
});

app.get('/produkte/:id', async (req, res) => {
  const productQ = await pool.query(`SELECT p.*, c.name AS category_name, COALESCE(c.age_level,0)::int AS age_level FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.active=true`, [req.params.id]);
  const product = productQ.rows[0];
  if (!product) return res.status(404).send('Produkt nicht gefunden');
  await pool.query('UPDATE products SET views_count = views_count + 1 WHERE id=$1', [product.id]);
  product.views_count = (product.views_count || 0) + 1;
  if (product.supplier_url) {
    const supplier = await checkSupplierStatus(product).catch(err => ({ status: 'unknown', note: err.message }));
    if (supplier && !supplier.skipped) {
      product.supplier_status = supplier.status;
      product.supplier_status_note = supplier.note;
      product.supplier_checked_at = new Date();
      if (supplier.status === 'out_of_stock') product.stock = 0;
    }
  }
  const variants = await pool.query('SELECT * FROM product_variants WHERE product_id=$1 AND active=true ORDER BY name', [product.id]);
  const stats = await pool.query(`
    SELECT COALESCE((SELECT SUM(quantity) FROM order_items WHERE product_id=$1),0)::int AS sold_count,
           COALESCE(ROUND(AVG(r.rating)::numeric, 2),0) AS avg_rating,
           COUNT(DISTINCT r.id)::int AS review_count
    FROM reviews r
    JOIN orders o ON o.id=r.order_id
    JOIN order_items oi ON oi.order_id=o.id
    WHERE oi.product_id=$1
  `, [product.id]);
  const reviews = await pool.query(`
    SELECT DISTINCT r.*, u.full_name
    FROM reviews r
    JOIN orders o ON o.id=r.order_id
    JOIN order_items oi ON oi.order_id=o.id
    JOIN users u ON u.id=r.user_id
    WHERE oi.product_id=$1
    ORDER BY r.created_at DESC
    LIMIT 25
  `, [product.id]);
  res.render('product-detail', { title: product.name, product, variants: variants.rows, stats: stats.rows[0], reviews: reviews.rows });
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

app.get('/register', async (req, res) => {
  const ageRestrictionEnabled = await isAgeRestrictionEnabled();
  const registrationCode = await registrationCodeSettings();
  res.render('auth', { title: 'Registrieren', mode: 'register', error: null, ageRestrictionEnabled, registrationCodeEnabled: registrationCode.enabled });
});
app.post('/register', async (req, res) => {
  const { email, password, full_name, street, postal_code, city, phone } = req.body;
  const ageRestrictionEnabled = await isAgeRestrictionEnabled();
  const registrationCode = await registrationCodeSettings();
  const renderRegisterError = (status, error) => res.status(status).render('auth', { title: 'Registrieren', mode: 'register', error, ageRestrictionEnabled, registrationCodeEnabled: registrationCode.enabled });
  try {
    if (registrationCode.enabled && normalizeCode(req.body.registration_code) !== normalizeCode(registrationCode.code)) {
      return renderRegisterError(403, 'Der Registrierungscode ist falsch.');
    }
    const ban = await findBanFor({ email, ip: clientIp(req), fullName: full_name, street, postalCode: postal_code, city });
    if (ban) return renderRegisterError(403, 'Registrierung oder Bestellung ist für diese Daten gesperrt.');
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`INSERT INTO users (email,password_hash,full_name,street,postal_code,city,phone,role,verification_level) VALUES ($1,$2,$3,$4,$5,$6,$7,'customer',0) RETURNING id`, [email.toLowerCase(), hash, full_name, street, postal_code, city, phone]);
    req.session.userId = rows[0].id;
    await logAudit(req, 'account_registered', 'user', rows[0].id, registrationCode.enabled ? 'Registrierungscode verwendet' : 'Normale Registrierung');
    res.redirect('/');
  } catch (err) {
    console.error('[Registrierung]', err.message);
    renderRegisterError(400, 'Diese E-Mail existiert bereits oder die Angaben sind ungültig.');
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
  if (rows[0].banned) req.session.accountError = `Dieses Konto ist gesperrt: ${rows[0].ban_reason || 'Kein Grund angegeben'}. Du kannst dich weiterhin einloggen und über das Support-Fenster Einspruch einlegen, aber keine Bestellung aufgeben.`;
  res.redirect(staffRoles.includes(rows[0].role) ? '/staff' : (rows[0].banned ? '/account' : '/'));
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));


app.get('/account', requireLogin, async (req, res) => {
  const giftOrders = res.locals.isCustomer ? await pool.query(`SELECT gco.*, gc.id AS gift_card_id, gc.code, gc.download_token FROM gift_card_orders gco LEFT JOIN gift_cards gc ON gc.gift_card_order_id=gco.id WHERE gco.user_id=$1 ORDER BY gco.created_at DESC LIMIT 30`, [res.locals.user.id]) : { rows: [] };
  const transactions = res.locals.isCustomer ? await pool.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40', [res.locals.user.id]) : { rows: [] };
  res.render('account', { title: 'Mein Konto', success: req.session.accountSuccess || null, error: req.session.accountError || null, giftOrders: giftOrders.rows, creditTransactions: transactions.rows });
  req.session.accountSuccess = null; req.session.accountError = null;
});
app.post('/account', requireLogin, async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  const street = String(req.body.street || '').trim();
  const postal = String(req.body.postal_code || '').trim();
  const city = String(req.body.city || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!fullName || !street || !postal || !city) { req.session.accountError='Bitte fülle Name, Straße, PLZ und Ort aus.'; return res.redirect('/account'); }
  await pool.query('UPDATE users SET full_name=$1, street=$2, postal_code=$3, city=$4, phone=$5 WHERE id=$6', [fullName, street, postal, city, phone || null, res.locals.user.id]);
  await logAudit(req, 'account_updated', 'user', res.locals.user.id, 'Nutzer hat seine Kundendaten geändert. Alte Daten bleiben in vorhandenen Bestellungen als Snapshot erhalten.');
  req.session.accountSuccess='Daten gespeichert. Bereits aufgegebene Bestellungen behalten ihre alten gespeicherten Daten.';
  res.redirect('/account');
});


app.post('/gift-cards/request', requireLogin, requireCustomer, async (req, res) => {
  const amount = priceToCents(req.body.amount);
  if (amount < 500 || amount > 50000) {
    req.session.accountError = 'Gutscheine müssen zwischen 5,00 € und 500,00 € liegen.';
    return res.redirect('/account');
  }
  const assignedStaffId = await chooseGiftCardStaff();
  const { rows } = await pool.query(`INSERT INTO gift_card_orders (user_id,assigned_staff_id,amount_cents,custom_message) VALUES ($1,$2,$3,$4) RETURNING *`, [res.locals.user.id, assignedStaffId, amount, String(req.body.custom_message || '').slice(0,500)]);
  await logAudit(req, 'gift_card_requested', 'gift_card_order', rows[0].id, money(amount));
  if (assignedStaffId) emailGiftCardRequest(rows[0].id, assignedStaffId).catch(err => console.error('[Mail Fehler] Gutschein-Anfrage:', err.message));
  req.session.accountSuccess = 'Gutschein angefragt. Nach bestätigter Zahlung wird die PDF automatisch bereitgestellt.';
  res.redirect('/account');
});

app.post('/account/redeem-gift-card', requireLogin, requireCustomer, async (req, res) => {
  const code = normalizeCode(req.body.code);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cardQ = await client.query("SELECT * FROM gift_cards WHERE code=$1 FOR UPDATE", [code]);
    const card = cardQ.rows[0];
    if (!card || card.status !== 'active' || card.remaining_cents <= 0) throw new Error('Dieser Gutscheincode ist ungültig oder bereits eingelöst.');
    await client.query('UPDATE users SET credit_cents=credit_cents+$1 WHERE id=$2', [card.remaining_cents, res.locals.user.id]);
    await client.query(`INSERT INTO credit_transactions (user_id,amount_cents,transaction_type,reference_type,reference_id,note,created_by) VALUES ($1,$2,'gift_card','gift_card',$3,$4,$1)`, [res.locals.user.id, card.remaining_cents, card.id, `Gutschein ${card.code} eingelöst`]);
    await client.query("UPDATE gift_cards SET remaining_cents=0,status='redeemed',redeemed_by_user_id=$1,redeemed_at=now() WHERE id=$2", [res.locals.user.id, card.id]);
    await client.query('COMMIT');
    await logAudit(req, 'gift_card_redeemed', 'gift_card', card.id, money(card.value_cents));
    req.session.accountSuccess = `${money(card.value_cents)} wurden deinem Guthaben hinzugefügt.`;
  } catch (err) {
    await client.query('ROLLBACK');
    req.session.accountError = err.message;
  } finally { client.release(); }
  res.redirect('/account');
});

app.get('/gift-cards/:id/pdf', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gift_cards WHERE id=$1 AND download_token=$2', [req.params.id, String(req.query.token || '')]);
  const card = rows[0];
  if (!card) return res.status(404).send('Geschenkkarte nicht gefunden.');
  streamGiftCardPdf(res, card);
});

app.get('/legal/:slug', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM legal_pages WHERE slug=$1', [req.params.slug]);
  const page = rows[0];
  if (!page) return res.status(404).send('Seite nicht gefunden');
  res.render('legal-page', { title: page.title, page });
});

app.post('/cart/add/:id', requireLogin, requireCustomer, async (req, res) => {
  const qty = Math.max(1, parseInt(req.body.quantity || '1', 10));
  const variantId = req.body.variant_id || null;
  const product = await pool.query('SELECT p.stock, COALESCE(c.age_level,0)::int AS age_level FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.active=true', [req.params.id]);
  if (!product.rows[0]) return res.redirect('/');
  if (await isAgeRestrictionEnabled() && product.rows[0].age_level > (res.locals.user.verification_level || 0)) return res.status(403).send(`Dieses Produkt ist ${product.rows[0].age_level}+ markiert. Bitte kontaktiere den Support, damit ein Staff deinen Account verifiziert.`);
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
  res.render('cart', { title: 'Warenkorb', items, subtotal, total, couponResult, couponError, couponSuccess, availableCredit: Math.max(0, Number(res.locals.user.credit_cents || 0)) });
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
  const ban = await findBanFor({ email: res.locals.user.email, ip: clientIp(req), fullName: res.locals.user.full_name, street: res.locals.user.street, postalCode: res.locals.user.postal_code, city: res.locals.user.city });
  if (res.locals.user.banned || ban) return res.status(403).send('Dein Konto kann aktuell keine Bestellungen aufgeben.');
  if (res.locals.user.temporary_suspended_until && new Date(res.locals.user.temporary_suspended_until).getTime() > Date.now()) {
    return res.status(403).send(`Dein Konto ist vorübergehend bis ${new Date(res.locals.user.temporary_suspended_until).toLocaleString('de-DE')} für Bestellungen gesperrt. Nutze den Support für Rückfragen.`);
  }
  if (req.body.legal_accept !== 'on') return res.status(400).send('Bitte bestätige die Bestell- und Rechtshinweise.');
  const canPayDelivery = res.locals.user.role === 'premcustomer' || res.locals.user.premium;
  const paymentMethod = req.body.payment_method === 'Bei Lieferung' && canPayDelivery ? 'Bei Lieferung' : 'Vorauszahlung';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedUser = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id])).rows[0];
    const cart = await client.query(`SELECT c.id AS cart_id, c.quantity, c.variant_id, p.*, COALESCE(cat.age_level,0)::int AS age_level, v.name AS variant_name, COALESCE(v.stock, p.stock) AS available_stock, COALESCE(v.stock, p.stock) AS stock FROM carts c JOIN products p ON p.id=c.product_id LEFT JOIN categories cat ON cat.id=p.category_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.user_id=$1 FOR UPDATE OF c,p`, [res.locals.user.id]);
    if (!cart.rows.length) throw new Error('Warenkorb ist leer.');
    if (await isAgeRestrictionEnabled()) {
      const blocked = cart.rows.find(item => (item.age_level || 0) > (res.locals.user.verification_level || 0));
      if (blocked) throw new Error(`${blocked.name} ist ${blocked.age_level}+ markiert. Bitte kontaktiere den Support zur Verifizierung.`);
    }
    for (const item of cart.rows) if (item.quantity > item.available_stock) throw new Error(`${item.name}${item.variant_name ? ' (' + item.variant_name + ')' : ''} ist nicht mehr genug auf Lager.`);
    const subtotal = sumItems(cart.rows);
    let couponResult = null;
    if (req.session.couponCode) {
      couponResult = await calculateDiscountForCode(client, req.session.couponCode, res.locals.user, cart.rows, true);
      if (!couponResult.valid) throw new Error(couponResult.error);
    }
    const discountCents = couponResult?.valid ? couponResult.discountCents : 0;
    const originalTotal = Math.max(0, subtotal - discountCents);
    const requestedCredit = priceToCents(req.body.credit_to_use);
    const creditUsed = Math.min(originalTotal, Math.max(0, Number(lockedUser.credit_cents || 0)), requestedCredit);
    const total = Math.max(0, originalTotal - creditUsed);
    const address = `${lockedUser.full_name}\n${lockedUser.street}\n${lockedUser.postal_code} ${lockedUser.city}\nTelefon: ${lockedUser.phone || '-'}`;
    const assignedStaffId = null;
    const finalPaymentMethod = total === 0 ? 'Guthaben' : paymentMethod;
    const paymentStatus = total === 0 ? 'Paid' : (paymentMethod === 'Bei Lieferung' ? 'Pay on delivery' : 'Unpaid');
    const order = await client.query(`INSERT INTO orders (user_id,assigned_staff_id,address_snapshot,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,original_total_cents,credit_used_cents,total_cents,payment_method,payment_status,delivery_status,discount_code_id,discount_code,discount_cents,legal_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Not Started',$12,$13,$14,now()) RETURNING *`, [res.locals.user.id, assignedStaffId, address, lockedUser.full_name || '', lockedUser.email || '', lockedUser.phone || '', originalTotal, creditUsed, total, finalPaymentMethod, paymentStatus, couponResult?.coupon?.id || null, couponResult?.code || null, discountCents]);
    if (creditUsed > 0) {
      await client.query('UPDATE users SET credit_cents=credit_cents-$1 WHERE id=$2', [creditUsed, res.locals.user.id]);
      await client.query(`INSERT INTO credit_transactions (user_id,amount_cents,transaction_type,reference_type,reference_id,note,created_by) VALUES ($1,$2,'order','order',$3,'Guthaben für Bestellung verwendet',$1)`, [res.locals.user.id, -creditUsed, order.rows[0].id]);
    }
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
    await client.query('INSERT INTO order_events (order_id,actor_id,event_type,note) VALUES ($1,$2,$3,$4)', [order.rows[0].id, res.locals.user.id, 'placed', 'Bestellung aufgegeben']);
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
    orderQ = await pool.query(`SELECT o.*, COALESCE(NULLIF(o.customer_email_snapshot,''),u.email) AS email, COALESCE(NULLIF(o.customer_name_snapshot,''),u.full_name) AS full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1`, [orderId]);
  } else if (user.role === 'staff') {
    orderQ = await pool.query(`SELECT o.*, COALESCE(NULLIF(o.customer_email_snapshot,''),u.email) AS email, COALESCE(NULLIF(o.customer_name_snapshot,''),u.full_name) AS full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1 AND o.assigned_staff_id=$2`, [orderId, user.id]);
  } else {
    orderQ = await pool.query(`SELECT o.*, COALESCE(NULLIF(o.customer_email_snapshot,''),u.email) AS email, COALESCE(NULLIF(o.customer_name_snapshot,''),u.full_name) AS full_name, s.full_name AS assigned_staff_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN users s ON s.id=o.assigned_staff_id WHERE o.id=$1 AND o.user_id=$2`, [orderId, user.id]);
  }
  return orderQ.rows[0];
}

app.get('/orders', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, COALESCE(items.items_text,'') AS items_text
    FROM orders o
    LEFT JOIN (
      SELECT order_id, string_agg(product_name || COALESCE(' (' || NULLIF(variant_name,'') || ')','') || ' ×' || quantity || ' = ' || to_char(((unit_price_cents*(100-discount_percent)/100)*quantity)/100.0, 'FM999999990.00') || '€', ', ' ORDER BY product_name) AS items_text
      FROM order_items GROUP BY order_id
    ) items ON items.order_id=o.id
    WHERE o.user_id=$1 AND archived_by_customer=false ORDER BY created_at DESC`, [res.locals.user.id]);
  res.render('orders', { title: 'Meine Bestellungen', orders: rows });
});
app.get('/orders/:id', requireLogin, requireOrderPermissionForStaff, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Bestellung nicht gefunden');
  if (res.locals.isCustomer) await pool.query('UPDATE orders SET customer_seen_at=now() WHERE id=$1', [order.id]);
  const items = await pool.query(`SELECT oi.*, p.staff_note AS current_staff_note FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.product_name, oi.variant_name NULLS LAST`, [order.id]);
  const messages = await pool.query('SELECT m.*, u.full_name, u.role FROM messages m JOIN users u ON u.id=m.sender_id WHERE order_id=$1 ORDER BY m.created_at ASC', [order.id]);
  const review = await pool.query('SELECT * FROM reviews WHERE order_id=$1', [order.id]);
  const events = await pool.query('SELECT e.*, u.full_name FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=$1 ORDER BY e.created_at ASC', [order.id]);
  let productsForOrder = [];
  if (res.locals.isStaff) {
    const pq = await pool.query('SELECT id,name,price_cents FROM products WHERE active=true ORDER BY name');
    productsForOrder = pq.rows;
  }
  res.render('order-detail', { title: 'Bestellung', order, items: items.rows, messages: messages.rows, review: review.rows[0], productsForOrder, events: events.rows });
});
app.post('/orders/:id/message', requireLogin, requireOrderPermissionForStaff, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Nicht gefunden');
  await pool.query('INSERT INTO messages (order_id,sender_id,body) VALUES ($1,$2,$3)', [order.id, res.locals.user.id, req.body.body]);
  await pool.query('UPDATE orders SET updated_at=now() WHERE id=$1', [order.id]);
  await addOrderEvent(order.id, res.locals.user.id, 'message', 'Neue Nachricht geschrieben');
  await emailNewMessage(order, res.locals.user, req.body.body);
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/review', requireLogin, requireCustomer, upload.single('image'), async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order || order.delivery_status !== 'Delivered') return res.status(403).send('Bewertung noch nicht möglich.');
  const currentReview = (await pool.query('SELECT * FROM reviews WHERE order_id=$1', [order.id])).rows[0];
  const imageUrl = req.file ? await storeReviewImage(req.file, order.id) : (currentReview?.image_url || null);
  await pool.query('INSERT INTO reviews (order_id,user_id,rating,comment,image_url) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_id) DO UPDATE SET rating=$3, comment=$4, image_url=$5', [order.id, res.locals.user.id, parseInt(req.body.rating,10), req.body.comment, imageUrl]);
  await addOrderEvent(order.id, res.locals.user.id, 'review', 'Bewertung gespeichert');
  res.redirect('/orders/' + order.id);
});
app.post('/orders/:id/archive', requireLogin, requireOrderPermissionForStaff, async (req, res) => {
  const order = await loadOrderForUser(req.params.id, res.locals.user);
  if (!order) return res.status(404).send('Nicht gefunden');
  const column = res.locals.isStaff ? 'archived_by_staff' : 'archived_by_customer';
  await pool.query(`UPDATE orders SET ${column}=true WHERE id=$1`, [order.id]);
  res.redirect(res.locals.isStaff ? '/staff/orders' : '/orders');
});

app.post('/staff/order-items/:itemId/prepared', requirePermission('can_manage_orders'), async (req, res) => {
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
  await logAudit(req, 'order_item_prepared_changed', 'order_item', item.id, req.body.prepared === 'on' ? 'prepared' : 'not prepared');
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
app.get('/staff/products', requirePermission('can_edit_products'), async (req, res) => {
  const selectedCategory = req.query.kategorie || '';
  const sort = req.query.sort || 'created_desc';
  const filters = {
    image: req.query.image || '',
    description: req.query.description || '',
    supplier: req.query.supplier || '',
    category: req.query.kategorie || ''
  };
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  const where = [];
  const params = [];
  if (selectedCategory) { params.push(selectedCategory); where.push(`p.category_id=$${params.length}`); }
  if (filters.image === 'yes') where.push(`p.image_url IS NOT NULL AND p.image_url <> ''`);
  if (filters.image === 'no') where.push(`(p.image_url IS NULL OR p.image_url = '')`);
  if (filters.description === 'yes') where.push(`p.description <> ''`);
  if (filters.description === 'no') where.push(`p.description = ''`);
  if (filters.supplier === 'yes') where.push(`COALESCE(TRIM(p.supplier_url),'') <> ''`);
  if (filters.supplier === 'no') where.push(`COALESCE(TRIM(p.supplier_url),'') = ''`);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderBy = productSortSql(sort);
  const products = await pool.query(`
    SELECT p.*, c.name AS category_name, COALESCE(c.age_level,0)::int AS age_level,
      COALESCE((SELECT SUM(v.stock) FROM product_variants v WHERE v.product_id = p.id), p.stock)::int AS display_stock,
      COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.product_id=p.id),0)::int AS sold_count,
      COALESCE((SELECT COUNT(*) FROM reviews r JOIN order_items oi ON oi.order_id=r.order_id WHERE oi.product_id=p.id),0)::int AS review_count
    FROM products p
    LEFT JOIN categories c ON c.id=p.category_id
    ${whereSql}
    ORDER BY ${orderBy}
  `, params);
  const productsWithVariants = await attachVariants(products.rows);
  res.render('staff-products', { title: 'Produkte bearbeiten', products: productsWithVariants, categories: categories.rows, selectedCategory, sort, filters, checked: req.query.checked || '', supplierDebug: req.query.supplierDebug || '' });
});

app.post('/staff/products/discount', requirePermission('can_edit_prices'), async (req, res) => {
  const discount = Math.max(0, Math.min(100, safeStockInt(req.body.discount_percent)));
  const categoryId = req.body.category_id || null;
  if (categoryId) await pool.query('UPDATE products SET discount_percent=$1 WHERE category_id=$2', [discount, categoryId]);
  else await pool.query('UPDATE products SET discount_percent=$1', [discount]);
  await logAudit(req, 'product_mass_discount_changed', 'category', categoryId || 'all', `${discount}%`);
  res.redirect('/staff/products' + (categoryId ? '?kategorie=' + encodeURIComponent(categoryId) : ''));
});

app.post('/staff/products/profit-category', requirePermission('can_edit_prices'), async (req, res) => {
  // Wichtig: $1 muss im SQL eindeutig typisiert werden.
  // Sonst kann PostgreSQL denselben Parameter einmal als INT und einmal als NUMERIC deuten
  // und wir bekommen: inconsistent types deduced for parameter $1.
  const profit = Math.max(0, Math.round(Number(req.body.target_profit_percent) || 0));
  const categoryId = req.body.category_id || '';
  if (!categoryId || !isUuidValue(categoryId)) return res.redirect('/staff/products');

  // Verkaufspreis = Einkaufspreis + Profit %. Nur Produkte mit Einkaufspreis > 0 werden angepasst.
  await pool.query(`
    UPDATE products
    SET target_profit_percent=$1::int,
        price_cents=GREATEST(0, ROUND(purchase_price_cents::numeric * (1 + ($1::numeric / 100.0)))::int)
    WHERE category_id=$2::uuid AND COALESCE(purchase_price_cents,0) > 0
  `, [profit, categoryId]);
  await logAudit(req, 'category_profit_changed', 'category', categoryId, `${profit}%`);
  res.redirect('/staff/products?kategorie=' + encodeURIComponent(categoryId));
});

app.post('/staff/products', requirePermission('can_edit_products'), upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, category_id, purchase_price, staff_note, supplier_url } = req.body;
  const canEditPrices = hasPermission(res, 'can_edit_prices');
  const cents = canEditPrices ? priceToCents(price) : 0;
  const purchaseCents = canEditPrices ? priceToCents(purchase_price) : 0;
  const targetProfit = profitPercentFromPrices(cents, purchaseCents);
  const effectiveDiscount = canEditPrices ? safeStockInt(discount_percent) : 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const finalCategoryId = await categoryOrDefault(category_id, client);
    const product = await client.query('INSERT INTO products (name,description,price_cents,purchase_price_cents,target_profit_percent,stock,discount_percent,image_url,category_id,staff_note,supplier_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [name, description, cents, purchaseCents, targetProfit, safeStockInt(stock), effectiveDiscount, null, finalCategoryId, staff_note || '', supplier_url || '']);
    const productId = product.rows[0].id;
    const imageUrl = req.file ? await storeProductImage(req.file, productId) : null;
    if (imageUrl) await client.query('UPDATE products SET image_url=$1 WHERE id=$2', [imageUrl, productId]);
    await replaceProductVariants(client, productId, parseVariants(req.body.variants));
    await syncProductStock(client, productId);
    await client.query('COMMIT');
    await logAudit(req, 'product_created', 'product', productId, name || '');
    res.redirect(productRedirect(req, productId));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).send(err.message);
  } finally { client.release(); }
});
app.post('/staff/products/check-suppliers', requirePermission('can_edit_products'), async (req, res) => {
  const checked = await checkAllSupplierStatuses({ force: true });
  // Manuelle Refreshs ändern den globalen Homepage-Cooldown absichtlich nicht.
  res.redirect('/staff/products?checked=' + checked);
});

app.post('/staff/products/:id', requirePermission('can_edit_products'), requireUuidParam, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, discount_percent, active, category_id, purchase_price, staff_note, supplier_url } = req.body;
  const existingPriceRow = (await pool.query('SELECT price_cents,purchase_price_cents,target_profit_percent,discount_percent FROM products WHERE id=$1', [req.params.id])).rows[0];
  const canEditPrices = hasPermission(res, 'can_edit_prices');
  const cents = canEditPrices ? priceToCents(price) : Number(existingPriceRow?.price_cents || 0);
  const purchaseCents = canEditPrices ? priceToCents(purchase_price) : Number(existingPriceRow?.purchase_price_cents || 0);
  const targetProfit = canEditPrices ? profitPercentFromPrices(cents, purchaseCents) : Number(existingPriceRow?.target_profit_percent || 0);
  const effectiveDiscount = canEditPrices ? safeStockInt(discount_percent) : Number(existingPriceRow?.discount_percent || 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const finalCategoryId = await categoryOrDefault(category_id, client);
    const imageUrl = req.file ? await storeProductImage(req.file, req.params.id) : req.body.old_image_url || null;
    await client.query('UPDATE products SET name=$1, description=$2, price_cents=$3, purchase_price_cents=$4, target_profit_percent=$5, stock=$6, discount_percent=$7, active=$8, image_url=$9, category_id=$10, staff_note=$11, supplier_url=$12 WHERE id=$13', [name, description, cents, purchaseCents, targetProfit, safeStockInt(stock), effectiveDiscount, active === 'on', imageUrl, finalCategoryId, staff_note || '', supplier_url || '', req.params.id]);
    await replaceProductVariants(client, req.params.id, parseVariants(req.body.variants));
    await syncProductStock(client, req.params.id);
    await client.query('COMMIT');
    await logAudit(req, 'product_updated', 'product', req.params.id, name || '');
    if ((req.get('accept') || '').includes('application/json') || req.get('x-requested-with') === 'fetch') return res.json({ ok: true, id: req.params.id });
    res.redirect(productRedirect(req, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    if ((req.get('accept') || '').includes('application/json') || req.get('x-requested-with') === 'fetch') return res.status(400).json({ ok: false, error: err.message });
    res.status(400).send(err.message);
  } finally { client.release(); }
});

app.post('/staff/products/:id/delete', requirePermission('can_delete_products'), requireUuidParam, async (req, res) => {
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
    await logAudit(req, 'product_deleted', 'product', req.params.id, product.name || '');
    res.redirect('/staff/products');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Produkt konnte nicht gelöscht werden.');
  } finally { client.release(); }
});


app.post('/staff/products/:id/check-supplier', requirePermission('can_edit_products'), requireUuidParam, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  const product = rows[0];
  if (!product) return res.status(404).send('Produkt nicht gefunden');
  const result = await checkSupplierStatus(product, { force: true });
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true, result });
  res.redirect(productRedirect(req, req.params.id));
});

app.post('/staff/products/:id/variants', requirePermission('can_edit_products'), requireUuidParam, async (req, res) => {
  const names = Array.isArray(req.body.variant_name) ? req.body.variant_name : [req.body.variant_name];
  const stocks = Array.isArray(req.body.variant_stock) ? req.body.variant_stock : [req.body.variant_stock];
  const ids = Array.isArray(req.body.variant_id) ? req.body.variant_id : [req.body.variant_id];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim();
    const stock = safeStockInt(stocks[i]);
    const id = ids[i];
    if (!id || !name) continue;
    await pool.query('UPDATE product_variants SET name=$1, stock=$2 WHERE id=$3 AND product_id=$4', [name, stock, id, req.params.id]);
  }
  const newName = String(req.body.new_variant_name || '').trim();
  if (newName) {
    await pool.query('INSERT INTO product_variants (product_id,name,stock) VALUES ($1,$2,$3) ON CONFLICT (product_id,name) DO UPDATE SET stock=EXCLUDED.stock', [req.params.id, newName, safeStockInt(req.body.new_variant_stock)]);
  }
  await syncProductStock(pool, req.params.id);
  if ((req.get('accept') || '').includes('application/json') || req.get('x-requested-with') === 'fetch') return res.json({ ok: true, id: req.params.id });
  res.redirect(productRedirect(req, req.params.id));
});
app.post('/staff/variants/:id/delete', requirePermission('can_edit_products'), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM product_variants WHERE id=$1 RETURNING product_id', [req.params.id]);
  if (rows[0]?.product_id) await syncProductStock(pool, rows[0].product_id);
  res.redirect('/staff/products' + (rows[0]?.product_id ? '#produkt-' + rows[0].product_id : ''));
});

app.get('/staff/categories', requirePermission('can_edit_products'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY name');
  res.render('staff-categories', { title: 'Kategorien', categories: rows });
});
app.post('/staff/categories', requirePermission('can_edit_products'), async (req, res) => {
  await pool.query('INSERT INTO categories (name,description,active,age_level) VALUES ($1,$2,true,$3) ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, active=true, age_level=EXCLUDED.age_level', [req.body.name, req.body.description || '', parseInt(req.body.age_level || '0',10) || 0]);
  await logAudit(req, 'category_saved', 'category', req.body.name, `Age-Level ${req.body.age_level || 0}`);
  res.redirect('/staff/categories');
});
app.post('/staff/categories/:id', requirePermission('can_edit_products'), async (req, res) => {
  await pool.query('UPDATE categories SET name=$1, description=$2, active=$3, age_level=$4 WHERE id=$5', [req.body.name, req.body.description || '', req.body.active === 'on', parseInt(req.body.age_level || '0',10) || 0, req.params.id]);
  await logAudit(req, 'category_updated', 'category', req.params.id, `Age-Level ${req.body.age_level || 0}`);
  res.redirect('/staff/categories');
});

app.get('/staff/orders', requirePermission('can_manage_orders'), async (req, res) => {
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
    SELECT o.*, COALESCE(NULLIF(o.customer_email_snapshot,''),u.email) AS email, COALESCE(NULLIF(o.customer_name_snapshot,''),u.full_name) AS full_name, s.full_name AS assigned_staff_name, COALESCE(prep.prepared_count,0)::int AS prepared_count, COALESCE(prep.item_count,0)::int AS item_count
    FROM orders o
    JOIN users u ON u.id=o.user_id
    LEFT JOIN users s ON s.id=o.assigned_staff_id
    LEFT JOIN (SELECT order_id, COUNT(*)::int AS item_count, COUNT(*) FILTER (WHERE prepared)::int AS prepared_count FROM order_items GROUP BY order_id) prep ON prep.order_id=o.id
    WHERE o.archived_by_staff=false AND ${whereByFilter} ${staffWhere}
    ORDER BY o.created_at DESC`, params);
  const staffUsers = res.locals.isOwner ? (await pool.query("SELECT u.id,u.full_name,u.email FROM users u LEFT JOIN staff_permissions sp ON sp.user_id=u.id WHERE u.role='owner' OR (u.role='staff' AND COALESCE(sp.can_manage_orders,true)=true) ORDER BY u.full_name")).rows : [];
  res.render('staff-orders', { title: 'Bestellungen', orders: rows, filter, staffUsers });
});
app.post('/staff/orders/:id/update', requirePermission('can_manage_orders'), async (req, res) => {
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
  let after = (await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
  if (before.status !== 'Denied' && status === 'Denied') {
    await refundOrderCredit(pool, after, 'Guthaben wegen abgelehnter Bestellung zurückerstattet');
    after = (await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
  }
  await emailOrderStatusUpdate(req.params.id, before, after);
  await addOrderEvent(req.params.id, res.locals.user.id, 'status_update', `Status: ${before.status}/${before.payment_status}/${before.delivery_status} -> ${status}/${payment_status}/${delivery_status}`);
  await logAudit(req, 'order_status_updated', 'order', req.params.id, `Status: ${status}, Zahlung: ${payment_status}, Lieferung: ${delivery_status}`);
  if (before.delivery_status !== 'Delivered' && delivery_status === 'Delivered') {
    await pool.query(`UPDATE users SET delivered_order_count = delivered_order_count + 1,
      premium = CASE WHEN delivered_order_count + 1 >= 5 THEN true ELSE premium END,
      role = CASE WHEN delivered_order_count + 1 >= 5 AND role='customer' THEN 'premcustomer' ELSE role END
      WHERE id=$1`, [before.user_id]);
  }
  res.redirect('/staff/orders?filter=' + encodeURIComponent(status === 'Denied' ? 'Denied' : (delivery_status === 'Delivered' ? 'Delivered' : status))); 
});



app.post('/staff/orders/:id/assign', requireOwner, async (req, res) => {
  const staffId = req.body.assigned_staff_id || null;
  if (staffId) {
    const ok = await pool.query("SELECT id FROM users WHERE id=$1 AND role IN ('owner','staff')", [staffId]);
    if (!ok.rows[0]) return res.status(400).send('Ungültiger Staff.');
  }
  await pool.query('UPDATE orders SET assigned_staff_id=$1, updated_at=now() WHERE id=$2', [staffId, req.params.id]);
  await addOrderEvent(req.params.id, res.locals.user.id, 'assigned', staffId ? 'Bestellung manuell zugeteilt' : 'Zuteilung entfernt');
  await logAudit(req, 'order_assigned', 'order', req.params.id, staffId || 'none');
  if (staffId) await emailStaffAssignment(req.params.id, staffId);
  res.redirect(req.get('referer') || '/staff/orders');
});

app.post('/staff/orders/:id/meeting', requirePermission('can_manage_meetings'), async (req, res) => {
  const before = (await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
  if (!before) return res.status(404).send('Bestellung nicht gefunden');
  if (!res.locals.isOwner && before.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  let meetingAt = null;
  if (req.body.meeting_at) meetingAt = (await pool.query(`SELECT ($1::timestamp AT TIME ZONE 'Europe/Berlin') AS meeting_at`, [req.body.meeting_at])).rows[0].meeting_at;
  await pool.query(`UPDATE orders SET meeting_location=$1,meeting_at=$2,meeting_note=$3,meeting_status='proposed',meeting_proposed_by=$4,updated_at=now() WHERE id=$5`, [req.body.meeting_location || '', meetingAt, req.body.meeting_note || '', res.locals.user.id, req.params.id]);
  await emailMeetingUpdate(req.params.id);
  await addOrderEvent(req.params.id, res.locals.user.id, 'meeting_proposed', `${req.body.meeting_location || '-'} / ${req.body.meeting_at || '-'} / ${req.body.meeting_note || ''}`);
  await logAudit(req, 'meeting_proposed', 'order', req.params.id, req.body.meeting_location || '');
  res.redirect('/orders/' + req.params.id);
});

app.post('/orders/:id/meeting-response', requireLogin, requireCustomer, async (req,res)=>{
  const order=await loadOrderForUser(req.params.id,res.locals.user);if(!order)return res.status(404).send('Bestellung nicht gefunden.');
  const action=String(req.body.action||'');
  if(action==='confirm'){
    await pool.query("UPDATE orders SET meeting_status='confirmed',updated_at=now() WHERE id=$1",[order.id]);
    await addOrderEvent(order.id,res.locals.user.id,'meeting_confirmed','Kunde hat Treffpunkt und Uhrzeit bestätigt.');
    emailMeetingCustomerResponse(order.id, 'Treffpunkt bestätigt').catch(err=>console.error('[Mail Fehler] Termin-Antwort:',err.message));
  }else if(action==='reject'){
    await pool.query("UPDATE orders SET meeting_status='rejected',meeting_note=$1,updated_at=now() WHERE id=$2",[String(req.body.note||'Abgelehnt').slice(0,500),order.id]);
    await addOrderEvent(order.id,res.locals.user.id,'meeting_rejected',String(req.body.note||'Kunde hat den Vorschlag abgelehnt.').slice(0,500));
    emailMeetingCustomerResponse(order.id, 'Treffpunkt abgelehnt', String(req.body.note||'')).catch(err=>console.error('[Mail Fehler] Termin-Antwort:',err.message));
  }else if(action==='counter'){
    let meetingAt=null;if(req.body.meeting_at)meetingAt=(await pool.query("SELECT ($1::timestamp AT TIME ZONE 'Europe/Berlin') AS v",[req.body.meeting_at])).rows[0].v;
    await pool.query("UPDATE orders SET meeting_location=$1,meeting_at=$2,meeting_note=$3,meeting_status='customer_proposed',meeting_proposed_by=$4,updated_at=now() WHERE id=$5",[req.body.meeting_location||'',meetingAt,String(req.body.note||'').slice(0,500),res.locals.user.id,order.id]);
    await addOrderEvent(order.id,res.locals.user.id,'meeting_counter_proposal',`${req.body.meeting_location||'-'} / ${req.body.meeting_at||'-'} / ${req.body.note||''}`);
    emailMeetingCustomerResponse(order.id, 'Gegenvorschlag gesendet', `${req.body.meeting_location||'-'} / ${req.body.meeting_at||'-'} / ${req.body.note||''}`).catch(err=>console.error('[Mail Fehler] Termin-Antwort:',err.message));
  }
  res.redirect('/orders/'+order.id);
});

app.post('/staff/orders/:id/meeting-confirm', requirePermission('can_manage_meetings'), async (req,res)=>{
  const order=(await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id])).rows[0];if(!order)return res.status(404).send('Bestellung nicht gefunden.');
  if(!res.locals.isOwner&&order.assigned_staff_id!==res.locals.user.id)return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  await pool.query("UPDATE orders SET meeting_status='confirmed',updated_at=now() WHERE id=$1",[order.id]);
  await addOrderEvent(order.id,res.locals.user.id,'meeting_confirmed','Staff hat den Gegenvorschlag bestätigt.');
  await emailMeetingUpdate(order.id);res.redirect('/orders/'+order.id);
});

app.post('/staff/orders/:id/costs', requireOwner, async (req, res) => {
  await pool.query('UPDATE orders SET extra_cost_cents=$1, extra_cost_note=$2, updated_at=now() WHERE id=$3', [priceToCents(req.body.extra_cost), req.body.extra_cost_note || '', req.params.id]);
  await logAudit(req, 'order_extra_cost_changed', 'order', req.params.id, `${req.body.extra_cost || '0'} / ${req.body.extra_cost_note || ''}`);
  res.redirect('/orders/' + req.params.id);
});

app.post('/staff/order-items/:itemId/update', requirePermission('can_manage_orders'), async (req, res) => {
  const q = await pool.query('SELECT oi.*, o.assigned_staff_id, o.delivery_status FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1', [req.params.itemId]);
  const item = q.rows[0];
  if (!item) return res.status(404).send('Artikel nicht gefunden');
  if (!res.locals.isOwner && item.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  if (item.delivery_status === 'Delivered') return res.status(400).send('Gelieferte Bestellungen können nicht mehr bearbeitet werden.');
  const qty = Math.max(1, parseInt(req.body.quantity || '1', 10));
  const unit = priceToCents(req.body.unit_price);
  await pool.query('UPDATE order_items SET quantity=$1, unit_price_cents=$2 WHERE id=$3', [qty, unit, item.id]);
  await recalculateOrderTotals(pool, item.order_id, res.locals.user.id);
  await logAudit(req, 'order_item_updated', 'order_item', item.id, `Menge ${qty}, Preis ${unit}`);
  res.redirect('/orders/' + item.order_id);
});

app.post('/staff/order-items/:itemId/delete', requirePermission('can_manage_orders'), async (req, res) => {
  const q = await pool.query('SELECT oi.*, o.assigned_staff_id, o.delivery_status FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1', [req.params.itemId]);
  const item = q.rows[0];
  if (!item) return res.status(404).send('Artikel nicht gefunden');
  if (!res.locals.isOwner && item.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  if (item.delivery_status === 'Delivered') return res.status(400).send('Gelieferte Bestellungen können nicht mehr bearbeitet werden.');
  await pool.query('DELETE FROM order_items WHERE id=$1', [item.id]);
  await recalculateOrderTotals(pool, item.order_id, res.locals.user.id);
  await logAudit(req, 'order_item_deleted', 'order_item', item.id, item.product_name || '');
  res.redirect('/orders/' + item.order_id);
});

app.post('/staff/orders/:id/add-item', requirePermission('can_manage_orders'), async (req, res) => {
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0];
  if (!order) return res.status(404).send('Bestellung nicht gefunden');
  if (!res.locals.isOwner && order.assigned_staff_id !== res.locals.user.id) return res.status(403).send('Diese Bestellung ist nicht dir zugeteilt.');
  if (order.delivery_status === 'Delivered') return res.status(400).send('Gelieferte Bestellungen können nicht mehr bearbeitet werden.');
  const product = (await pool.query('SELECT * FROM products WHERE id=$1', [req.body.product_id])).rows[0];
  if (!product) return res.status(404).send('Produkt nicht gefunden');
  let variantName = null;
  if (req.body.variant_id) {
    const v = (await pool.query('SELECT * FROM product_variants WHERE id=$1 AND product_id=$2', [req.body.variant_id, product.id])).rows[0];
    variantName = v?.name || null;
  }
  const qty = Math.max(1, parseInt(req.body.quantity || '1', 10));
  await pool.query(`INSERT INTO order_items (order_id,product_id,product_name,variant_name,variety,unit_price_cents,purchase_price_cents,discount_percent,staff_note_snapshot,quantity)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [order.id, product.id, product.name, variantName, variantName || '', product.price_cents, product.purchase_price_cents || 0, product.discount_percent || 0, product.staff_note || '', qty]);
  await recalculateOrderTotals(pool, order.id, res.locals.user.id);
  await logAudit(req, 'order_item_added', 'order', order.id, `${product.name} x${qty}`);
  res.redirect('/orders/' + order.id);
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
    if (order.credit_used_cents > 0 && !order.credit_refunded_at) {
      await refundOrderCredit(client, order, 'Guthaben wegen gelöschter Bestellung zurückerstattet');
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
    await logAudit(req, 'order_deleted', 'order', order.id, req.body.restore_stock === 'on' ? 'Lager zurückgebucht' : 'Ohne Lagerrückbuchung');
    res.redirect('/staff/orders?filter=' + encodeURIComponent(req.body.return_filter || 'Placed'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Bestellung konnte nicht gelöscht werden.');
  } finally { client.release(); }
});

app.get('/staff/discount-codes', requirePermission('can_manage_discounts'), async (req, res) => {
  const codes = await pool.query(`SELECT dc.*, c.name AS category_name, COALESCE(c.age_level,0)::int AS age_level, u.email AS account_email, creator.full_name AS creator_name
    FROM discount_codes dc
    LEFT JOIN categories c ON c.id=dc.category_id
    LEFT JOIN users u ON u.id=dc.account_specific_user_id
    LEFT JOIN users creator ON creator.id=dc.created_by
    ORDER BY dc.created_at DESC`);
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  const users = await pool.query("SELECT id,email,full_name,role FROM users WHERE role IN ('customer','premcustomer') ORDER BY created_at DESC LIMIT 200");
  res.render('staff-discount-codes', { title: 'Rabattcodes', codes: codes.rows, categories: categories.rows, users: users.rows, error: req.query.error || null });
});
app.post('/staff/discount-codes', requirePermission('can_manage_discounts'), async (req, res) => {
  const code = normalizeCode(req.body.code);
  if (!code) return res.redirect('/staff/discount-codes?error=' + encodeURIComponent('Code fehlt.'));
  const discountType = req.body.discount_mode === 'percent' ? 'percent' : req.body.discount_mode === 'fixed' ? 'fixed' : 'none';
  const discountPercent = discountType === 'percent' ? Math.max(0, Math.min(100, safeStockInt(req.body.discount_percent))) : 0;
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
    const created = await pool.query(`INSERT INTO discount_codes (code,description,active,discount_type,discount_percent,discount_cents,max_discount_cents,buy_x,get_y,account_specific_user_id,category_id,min_order_cents,expires_at,max_uses,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [code, req.body.description || '', req.body.active === 'on', discountType, discountPercent, discountCents, maxDiscountCents, buyX, getY, accountId, categoryId, minOrderCents, expiresAt, maxUses, res.locals.user.id]);
    await logAudit(req, 'discount_code_created', 'discount_code', created.rows[0].id, code);
    if (req.body.active === 'on') {
      emailDiscountCodeCreated(created.rows[0].id).catch(err => console.error('[Mail Fehler] Rabattcode-Mail:', err.message));
    }
    res.redirect('/staff/discount-codes');
  } catch (err) {
    console.error(err);
    res.redirect('/staff/discount-codes?error=' + encodeURIComponent('Rabattcode konnte nicht erstellt werden. Vielleicht existiert der Code schon.'));
  }
});
app.post('/staff/discount-codes/:id/toggle', requirePermission('can_manage_discounts'), async (req, res) => {
  await pool.query('UPDATE discount_codes SET active = NOT active WHERE id=$1', [req.params.id]);
  await logAudit(req, 'discount_code_toggled', 'discount_code', req.params.id, '');
  res.redirect('/staff/discount-codes');
});
app.post('/staff/discount-codes/:id/delete', requirePermission('can_manage_discounts'), async (req, res) => {
  await pool.query('DELETE FROM discount_codes WHERE id=$1', [req.params.id]);
  await logAudit(req, 'discount_code_deleted', 'discount_code', req.params.id, '');
  res.redirect('/staff/discount-codes');
});

app.get('/staff/customers', requirePermission('can_manage_users'), async (req, res) => {
  const type = req.query.type || 'customers';
  const where = type === 'premium' ? "WHERE role='premcustomer' OR premium=true" : type === 'staff' ? "WHERE role IN ('owner','staff')" : "WHERE role='customer' AND premium=false";
  const { rows } = await pool.query(`
    SELECT id,email,full_name,street,postal_code,city,role,premium,delivered_order_count,created_at,banned,ban_reason,internal_note,verification_level,credit_cents,temporary_suspended_until,temporary_suspension_reason,
      EXISTS(SELECT 1 FROM ban_rules br WHERE br.type='email' AND br.value=lower(users.email)) AS email_banned,
      EXISTS(SELECT 1 FROM ban_rules br WHERE br.type='identity' AND br.value=lower(trim(coalesce(users.full_name,'') || '|' || coalesce(users.street,'') || '|' || coalesce(users.postal_code,'') || '|' || coalesce(users.city,'')))) AS identity_banned
    FROM users ${where}
    ORDER BY created_at DESC`);
  res.render('staff-customers', { title: 'Nutzer', customers: rows, type });
});

app.post('/staff/users/:id/verification', requirePermission('can_verify_age'), async (req, res) => {
  const level = [0,16,18].includes(parseInt(req.body.verification_level,10)) ? parseInt(req.body.verification_level,10) : 0;
  await pool.query('UPDATE users SET verification_level=$1 WHERE id=$2 AND role IN (\'customer\',\'premcustomer\')', [level, req.params.id]);
  await logAudit(req, 'user_verification_changed', 'user', req.params.id, verificationLabel(level));
  res.redirect('/staff/customers?type=' + encodeURIComponent(req.body.return_type || 'customers'));
});

app.post('/staff/users/:id/role', requireOwner, async (req, res) => {
  const allowed = ['owner','staff','customer','premcustomer'];
  const role = allowed.includes(req.body.role) ? req.body.role : 'customer';
  const premium = role === 'premcustomer' || role === 'owner';
  await pool.query('UPDATE users SET role=$1, premium=$2 WHERE id=$3', [role, premium, req.params.id]);
  if (role === 'staff') await pool.query('INSERT INTO staff_permissions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.params.id]);
  await logAudit(req, 'user_role_changed', 'user', req.params.id, role);
  res.redirect('/staff/customers');
});



app.post('/staff/users/:id/note', requirePermission('can_manage_users'), async (req, res) => {
  await pool.query('UPDATE users SET internal_note=$1 WHERE id=$2', [req.body.internal_note || '', req.params.id]);
  await logAudit(req, 'user_note_updated', 'user', req.params.id, String(req.body.internal_note || '').slice(0,500));
  res.redirect('/staff/customers?type=' + encodeURIComponent(req.body.return_type || 'customers'));
});

app.post('/staff/users/:id/ban', requirePermission('can_ban_users'), async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!user) return res.status(404).send('Nutzer nicht gefunden');
  const reason = req.body.ban_reason || 'Gesperrt';
  const emailValue = String(user.email || '').toLowerCase();
  const identityValue = identityKey(user.full_name, user.street, user.postal_code, user.city);

  const bannedNow = req.body.banned === 'on';
  await pool.query('UPDATE users SET banned=$1, ban_reason=$2 WHERE id=$3', [bannedNow, reason, user.id]);

  if (user.banned !== bannedNow) {
    emailBanUpdate(user, reason, bannedNow).catch(err => console.error('[Mail Fehler] Ban-Mail:', err.message));
  }

  if (req.body.ban_email === 'on') {
    await pool.query(`INSERT INTO ban_rules (type,value,reason,created_by)
      SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM ban_rules WHERE type=$1 AND value=$2)`,
      ['email', emailValue, reason, res.locals.user.id]);
  } else {
    await pool.query('DELETE FROM ban_rules WHERE type=$1 AND value=$2', ['email', emailValue]);
  }

  if (req.body.ban_identity === 'on') {
    await pool.query(`INSERT INTO ban_rules (type,value,reason,created_by)
      SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM ban_rules WHERE type=$1 AND value=$2)`,
      ['identity', identityValue, reason, res.locals.user.id]);
  } else {
    await pool.query('DELETE FROM ban_rules WHERE type=$1 AND value=$2', ['identity', identityValue]);
  }

  await logAudit(req, bannedNow ? 'user_banned' : 'user_unbanned', 'user', user.id, reason);
  res.redirect('/staff/customers?type=' + encodeURIComponent(req.body.return_type || 'customers'));
});

app.post('/staff/ban-ip', requirePermission('can_ban_users'), async (req, res) => {
  const value = String(req.body.ip || '').trim();
  if (value) { await pool.query('INSERT INTO ban_rules (type,value,reason,created_by) VALUES ($1,$2,$3,$4)', ['ip', value, req.body.reason || '', res.locals.user.id]); await logAudit(req, 'ip_ban_created', 'ban_rule', value, req.body.reason || ''); }
  res.redirect('/staff/customers?type=' + encodeURIComponent(req.body.return_type || 'customers'));
});

app.post('/staff/users/:id/reset-link', requireOwner, async (req, res) => {
  const user = (await pool.query('SELECT id,email,full_name,role FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!user) return res.status(404).send('Nutzer nicht gefunden');
  const token = await createPasswordReset(user.id, res.locals.user.id);
  await sendMail(user.email, 'Premium Shop: Passwort-Reset vom Owner', `<h2>Passwort zurücksetzen</h2><p>Hallo ${escapeHtml(user.full_name)},</p><p>Der Owner hat einen Passwort-Reset-Link für dich erstellt:</p><p><a href="${escapeHtml(resetUrl(token))}">${escapeHtml(resetUrl(token))}</a></p><p>Der Link ist 2 Stunden gültig.</p>`);
  res.redirect('/staff/customers?reset=sent');
});



async function loadSupportConversationForStaff(conversationId, user) {
  const params=[conversationId];
  let staffWhere='';
  if (user.role !== 'owner') { params.push(user.id); staffWhere='AND sc.assigned_staff_id=$2'; }
  const { rows } = await pool.query(`SELECT sc.*, u.full_name AS customer_name,u.email AS customer_email,u.verification_level,u.credit_cents,u.banned,u.temporary_suspended_until,s.full_name AS staff_name
    FROM support_conversations sc JOIN users u ON u.id=sc.user_id LEFT JOIN users s ON s.id=sc.assigned_staff_id
    WHERE sc.id=$1 ${staffWhere}`, params);
  return rows[0] || null;
}

app.get('/api/support/faqs', requireLogin, requireCustomer, async (req,res)=>{
  const { rows } = await pool.query('SELECT id,question,answer FROM support_faqs WHERE active=true ORDER BY sort_order,created_at');
  res.json({ faqs: rows });
});
app.get('/api/support/current', requireLogin, requireCustomer, async (req,res)=>{
  const convoQ = await pool.query("SELECT * FROM support_conversations WHERE user_id=$1 AND status <> 'closed' ORDER BY updated_at DESC LIMIT 1", [res.locals.user.id]);
  const conversation=convoQ.rows[0]||null;
  if(!conversation) return res.json({conversation:null,messages:[]});
  const messages=await pool.query('SELECT sm.*,u.full_name,u.role FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE conversation_id=$1 ORDER BY sm.created_at', [conversation.id]);
  res.json({conversation,messages:messages.rows});
});
app.post('/api/support/conversations', requireLogin, requireCustomer, async (req,res)=>{
  const open=await pool.query("SELECT id FROM support_conversations WHERE user_id=$1 AND status <> 'closed' ORDER BY updated_at DESC LIMIT 1", [res.locals.user.id]);
  if(open.rows[0]) {
    const c=(await pool.query('SELECT * FROM support_conversations WHERE id=$1',[open.rows[0].id])).rows[0];
    const m=await pool.query('SELECT sm.*,u.full_name,u.role FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE conversation_id=$1 ORDER BY sm.created_at',[c.id]);
    return res.json({conversation:c,messages:m.rows});
  }
  const category=String(req.body.category||'Allgemein').slice(0,80);
  const subject=String(req.body.subject||category).trim().slice(0,120);
  const message=String(req.body.message||'').trim().slice(0,2000);
  if(!message) return res.status(400).json({error:'Bitte beschreibe dein Problem.'});
  const staffId=await chooseSupportStaff();
  const { rows }=await pool.query(`INSERT INTO support_conversations (user_id,assigned_staff_id,category,subject,status) VALUES ($1,$2,$3,$4,'waiting_staff') RETURNING *`,[res.locals.user.id,staffId,category,subject]);
  await pool.query('INSERT INTO support_messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)',[rows[0].id,res.locals.user.id,message]);
  if(staffId) emailSupportAssignment(rows[0].id,staffId).catch(err=>console.error('[Mail Fehler] Support-Ping:',err.message));
  await logAudit(req,'support_conversation_created','support',rows[0].id,subject);
  const messages=await pool.query('SELECT sm.*,u.full_name,u.role FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE conversation_id=$1 ORDER BY sm.created_at',[rows[0].id]);
  res.json({conversation:rows[0],messages:messages.rows});
});
app.post('/api/support/conversations/:id/messages', requireLogin, requireCustomer, async (req,res)=>{
  const c=(await pool.query("SELECT * FROM support_conversations WHERE id=$1 AND user_id=$2 AND status <> 'closed'",[req.params.id,res.locals.user.id])).rows[0];
  if(!c) return res.status(404).json({error:'Conversation nicht gefunden.'});
  const message=String(req.body.message||'').trim().slice(0,2000);
  if(!message) return res.status(400).json({error:'Nachricht fehlt.'});
  await pool.query('INSERT INTO support_messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)',[c.id,res.locals.user.id,message]);
  await pool.query("UPDATE support_conversations SET status='waiting_staff',updated_at=now() WHERE id=$1",[c.id]);
  emailSupportCustomerMessage(c.id, message).catch(err=>console.error('[Mail Fehler] Support-Nachricht:',err.message));
  const updated=(await pool.query('SELECT * FROM support_conversations WHERE id=$1',[c.id])).rows[0];
  const messages=await pool.query('SELECT sm.*,u.full_name,u.role FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE conversation_id=$1 ORDER BY sm.created_at',[c.id]);
  res.json({conversation:updated,messages:messages.rows});
});

app.get('/staff/support', requirePermission('can_manage_support'), async (req,res)=>{
  const status=String(req.query.status||'open');
  const params=[status==='open'?null:status];
  let where=status==='open'?"sc.status <> 'closed'":"sc.status=$1";
  if(!res.locals.isOwner){params.push(res.locals.user.id);where+=` AND sc.assigned_staff_id=$${params.length}`;}
  const used=params[0]===null?params.slice(1):params;
  if(params[0]===null && !res.locals.isOwner) where="sc.status <> 'closed' AND sc.assigned_staff_id=$1";
  const {rows}=await pool.query(`SELECT sc.*,u.full_name AS customer_name,u.email AS customer_email,s.full_name AS staff_name FROM support_conversations sc JOIN users u ON u.id=sc.user_id LEFT JOIN users s ON s.id=sc.assigned_staff_id WHERE ${where} ORDER BY sc.updated_at DESC`,used);
  res.render('staff-support',{title:'Customer Support',conversations:rows,status});
});
app.get('/staff/support/:id', requirePermission('can_manage_support'), async (req,res)=>{
  const conversation=await loadSupportConversationForStaff(req.params.id,res.locals.user);
  if(!conversation)return res.status(404).send('Conversation nicht gefunden.');
  const messages=await pool.query('SELECT sm.*,u.full_name,u.role FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE conversation_id=$1 ORDER BY sm.created_at',[conversation.id]);
  const staffUsers=res.locals.isOwner?(await pool.query("SELECT id,full_name FROM users WHERE role IN ('owner','staff') ORDER BY full_name")).rows:[];
  res.render('staff-support-detail',{title:`Support #${conversation.conversation_no}`,conversation,messages:messages.rows,staffUsers});
});
app.post('/staff/support/:id/message', requirePermission('can_manage_support'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user); if(!c)return res.status(404).send('Conversation nicht gefunden.');
  const message=String(req.body.message||'').trim().slice(0,2000); if(!message)return res.redirect('/staff/support/'+c.id);
  await pool.query('INSERT INTO support_messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)',[c.id,res.locals.user.id,message]);
  await pool.query("UPDATE support_conversations SET status='waiting_customer',updated_at=now() WHERE id=$1",[c.id]);
  await sendMail(c.customer_email,`Premium Shop Support #${c.conversation_no}`,`<h2>Neue Support-Antwort</h2><p>${escapeHtml(message)}</p><p>Öffne das Support-Fenster auf der Website, um zu antworten.</p>`);
  res.redirect('/staff/support/'+c.id);
});
app.post('/staff/support/:id/status', requirePermission('can_manage_support'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user); if(!c)return res.status(404).send('Conversation nicht gefunden.');
  const allowed=['open','waiting_staff','waiting_customer','closed']; const status=allowed.includes(req.body.status)?req.body.status:'open';
  await pool.query('UPDATE support_conversations SET status=$1,updated_at=now(),closed_at=CASE WHEN $1=\'closed\' THEN now() ELSE NULL END WHERE id=$2',[status,c.id]);
  await logAudit(req,'support_status_changed','support',c.id,status); res.redirect('/staff/support/'+c.id);
});
app.post('/staff/support/:id/assign', requireOwner, async (req,res)=>{
  const staffId=req.body.assigned_staff_id||null;
  if(staffId){const q=await pool.query("SELECT id FROM users WHERE id=$1 AND role IN ('owner','staff')",[staffId]);if(!q.rows[0])return res.status(400).send('Ungültiger Staff.');}
  await pool.query('UPDATE support_conversations SET assigned_staff_id=$1,updated_at=now() WHERE id=$2',[staffId,req.params.id]);
  if(staffId)emailSupportAssignment(req.params.id,staffId).catch(()=>{});
  await logAudit(req,'support_assigned','support',req.params.id,staffId||'none');res.redirect('/staff/support/'+req.params.id);
});
app.post('/staff/support/:id/verification', requirePermission('can_verify_age'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user);if(!c)return res.status(404).send('Conversation nicht gefunden.');
  const level=[0,16,18].includes(Number(req.body.verification_level))?Number(req.body.verification_level):0;
  await pool.query('UPDATE users SET verification_level=$1 WHERE id=$2',[level,c.user_id]);
  await logAudit(req,'user_verification_changed','user',c.user_id,verificationLabel(level));res.redirect('/staff/support/'+c.id);
});
app.post('/staff/support/:id/suspend', requirePermission('can_ban_users'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user);if(!c)return res.status(404).send('Conversation nicht gefunden.');
  let until=null;if(req.body.until){until=(await pool.query("SELECT ($1::timestamp AT TIME ZONE 'Europe/Berlin') AS v",[req.body.until])).rows[0].v;}
  await pool.query('UPDATE users SET temporary_suspended_until=$1,temporary_suspension_reason=$2 WHERE id=$3',[until,until?String(req.body.reason||'Temporär gesperrt').slice(0,500):'',c.user_id]);
  await logAudit(req,'temporary_suspension_changed','user',c.user_id,until?String(until):'removed');res.redirect('/staff/support/'+c.id);
});
app.post('/staff/support/:id/ban', requirePermission('can_ban_users'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user);if(!c)return res.status(404).send('Conversation nicht gefunden.');
  const banned=req.body.banned==='true';const reason=String(req.body.reason||'').slice(0,500);
  const userForMail=(await pool.query('SELECT * FROM users WHERE id=$1',[c.user_id])).rows[0];
  await pool.query('UPDATE users SET banned=$1,ban_reason=$2 WHERE id=$3',[banned,banned?reason:'',c.user_id]);
  if(userForMail) emailBanUpdate(userForMail, reason, banned).catch(err=>console.error('[Mail Fehler] Ban-Mail:',err.message));
  await logAudit(req,banned?'user_banned':'user_unbanned','user',c.user_id,reason);res.redirect('/staff/support/'+c.id);
});
app.post('/staff/support/:id/credit', requirePermission('can_adjust_credit'), async (req,res)=>{
  const c=await loadSupportConversationForStaff(req.params.id,res.locals.user);if(!c)return res.status(404).send('Conversation nicht gefunden.');
  const raw=parseFloat(String(req.body.amount||'0').replace(',','.'));const amount=Number.isFinite(raw)?Math.round(raw*100):0;if(!amount)return res.redirect('/staff/support/'+c.id);
  const client=await pool.connect();try{await client.query('BEGIN');const u=(await client.query('SELECT credit_cents FROM users WHERE id=$1 FOR UPDATE',[c.user_id])).rows[0];const newBalance=Math.max(0,Number(u.credit_cents||0)+amount);const applied=newBalance-Number(u.credit_cents||0);await client.query('UPDATE users SET credit_cents=$1 WHERE id=$2',[newBalance,c.user_id]);await client.query(`INSERT INTO credit_transactions (user_id,amount_cents,transaction_type,reference_type,reference_id,note,created_by) VALUES ($1,$2,'manual','support',$3,$4,$5)`,[c.user_id,applied,c.id,String(req.body.note||'Manuelle Support-Anpassung').slice(0,500),res.locals.user.id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await logAudit(req,'credit_adjusted','user',c.user_id,String(amount));res.redirect('/staff/support/'+c.id);
});

app.get('/staff/gift-cards', requirePermission('can_manage_gift_cards'), async (req,res)=>{
  const status=String(req.query.status||'requested');const params=[status];let where='gco.status=$1';if(!res.locals.isOwner){params.push(res.locals.user.id);where+=' AND gco.assigned_staff_id=$2';}
  const {rows}=await pool.query(`SELECT gco.*,u.full_name AS customer_name,u.email AS customer_email,s.full_name AS staff_name,gc.id AS gift_card_id,gc.code,gc.download_token FROM gift_card_orders gco JOIN users u ON u.id=gco.user_id LEFT JOIN users s ON s.id=gco.assigned_staff_id LEFT JOIN gift_cards gc ON gc.gift_card_order_id=gco.id WHERE ${where} ORDER BY gco.created_at DESC`,params);
  res.render('staff-gift-cards',{title:'Gutscheinbestellungen',orders:rows,status});
});
app.post('/staff/gift-cards/:id/paid', requirePermission('can_manage_gift_cards'), async (req,res)=>{
  const client=await pool.connect();let cardId=null;try{await client.query('BEGIN');const q=await client.query('SELECT * FROM gift_card_orders WHERE id=$1 FOR UPDATE',[req.params.id]);const g=q.rows[0];if(!g)throw new Error('Anfrage nicht gefunden.');if(g.status==='cancelled')throw new Error('Diese Anfrage wurde storniert.');if(!res.locals.isOwner&&g.assigned_staff_id!==res.locals.user.id)throw new Error('Nicht dir zugeteilt.');const existing=(await client.query('SELECT * FROM gift_cards WHERE gift_card_order_id=$1',[g.id])).rows[0];if(existing){cardId=existing.id;}else{let created=null;for(let i=0;i<5&&!created;i++){try{const code=giftCardCode();const token=crypto.randomBytes(24).toString('hex');created=(await client.query(`INSERT INTO gift_cards (gift_card_order_id,code,value_cents,remaining_cents,purchaser_user_id,custom_message,download_token) VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING *`,[g.id,code,g.amount_cents,g.user_id,g.custom_message||'',token])).rows[0];}catch(e){if(e.code!=='23505')throw e;}}if(!created)throw new Error('Gutscheincode konnte nicht erstellt werden.');cardId=created.id;}await client.query("UPDATE gift_card_orders SET status='paid',paid_at=now() WHERE id=$1",[g.id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');return res.status(400).send(e.message);}finally{client.release();}
  await logAudit(req,'gift_card_paid','gift_card_order',req.params.id,cardId);emailGiftCardReady(cardId).catch(err=>console.error('[Mail Fehler] Gutschein:',err.message));res.redirect('/staff/gift-cards?status=paid');
});
app.post('/staff/gift-cards/:id/cancel', requirePermission('can_manage_gift_cards'), async (req,res)=>{
  const q=await pool.query('SELECT * FROM gift_card_orders WHERE id=$1',[req.params.id]);const g=q.rows[0];if(!g)return res.status(404).send('Nicht gefunden.');if(!res.locals.isOwner&&g.assigned_staff_id!==res.locals.user.id)return res.status(403).send('Nicht dir zugeteilt.');await pool.query("UPDATE gift_card_orders SET status='cancelled',cancelled_at=now() WHERE id=$1 AND status='requested'",[g.id]);await logAudit(req,'gift_card_cancelled','gift_card_order',g.id,'');res.redirect('/staff/gift-cards?status=cancelled');
});

app.get('/staff/permissions', requireOwner, async (req,res)=>{
  await pool.query("INSERT INTO staff_permissions (user_id) SELECT id FROM users WHERE role='staff' ON CONFLICT (user_id) DO NOTHING");
  const {rows}=await pool.query("SELECT u.id,u.full_name,u.email,sp.* FROM users u JOIN staff_permissions sp ON sp.user_id=u.id WHERE u.role='staff' ORDER BY u.full_name");
  res.render('staff-permissions',{title:'Staff-Rechte',staffUsers:rows,permissionKeys,permissionLabels});
});
app.post('/staff/permissions/:id', requireOwner, async (req,res)=>{
  const values=permissionKeys.map(k=>req.body[k]==='on');
  const columns=['user_id',...permissionKeys].join(',');
  const placeholders=Array.from({length:permissionKeys.length+1},(_,i)=>`$${i+1}`).join(',');
  const sets=permissionKeys.map(k=>`${k}=EXCLUDED.${k}`).join(',');
  await pool.query(`INSERT INTO staff_permissions (${columns}) VALUES (${placeholders}) ON CONFLICT (user_id) DO UPDATE SET ${sets},updated_at=now()`,[req.params.id,...values]);
  await logAudit(req,'staff_permissions_updated','user',req.params.id,permissionKeys.filter((k,i)=>values[i]).join(','));res.redirect('/staff/permissions');
});

app.get('/staff/profit', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`
    WITH order_finance AS (
      SELECT o.id, o.created_at, o.extra_cost_cents,
        COALESCE(SUM(ROUND(oi.unit_price_cents*(100-oi.discount_percent)/100.0)*oi.quantity),0)::int AS revenue,
        COALESCE(SUM(oi.purchase_price_cents*oi.quantity),0)::int AS cost,
        COALESCE(SUM((ROUND(oi.unit_price_cents*(100-oi.discount_percent)/100.0)-oi.purchase_price_cents)*oi.quantity),0)::int AS gross_profit
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.delivery_status='Delivered' AND o.status='Accepted'
      GROUP BY o.id
    )
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', now()) THEN gross_profit-extra_cost_cents ELSE 0 END),0)::int AS day_profit,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', now()) THEN gross_profit-extra_cost_cents ELSE 0 END),0)::int AS week_profit,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', now()) THEN gross_profit-extra_cost_cents ELSE 0 END),0)::int AS month_profit,
      COALESCE(SUM(gross_profit-extra_cost_cents),0)::int AS total_profit,
      COALESCE(SUM(revenue),0)::int AS total_revenue,
      COALESCE(SUM(cost),0)::int AS total_cost,
      COALESCE(SUM(extra_cost_cents),0)::int AS total_extra_cost
    FROM order_finance
  `);
  const items = await pool.query(`
    SELECT oi.product_name, COALESCE(oi.variant_name,'') AS variant_name, SUM(oi.quantity)::int AS qty,
      COALESCE(SUM(ROUND(oi.unit_price_cents*(100-oi.discount_percent)/100.0) * oi.quantity),0)::int AS revenue,
      COALESCE(SUM(oi.purchase_price_cents * oi.quantity),0)::int AS cost,
      COALESCE(SUM((ROUND(oi.unit_price_cents*(100-oi.discount_percent)/100.0) - oi.purchase_price_cents) * oi.quantity),0)::int AS profit
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.delivery_status='Delivered' AND o.status='Accepted'
    GROUP BY oi.product_name, oi.variant_name
    ORDER BY profit DESC
  `);
  const extraOrders = await pool.query(`SELECT id, created_at, extra_cost_cents, extra_cost_note, total_cents FROM orders WHERE delivery_status='Delivered' AND status='Accepted' AND extra_cost_cents > 0 ORDER BY created_at DESC LIMIT 50`);
  res.render('staff-profit', { title: 'Profit', summary: rows[0], items: items.rows, extraOrders: extraOrders.rows });
});


app.get('/staff/settings', requireOwner, async (req, res) => {
  const registrationCode = await registrationCodeSettings();
  const faqs = await pool.query('SELECT * FROM support_faqs ORDER BY sort_order,created_at');
  res.render('staff-settings', { title: 'Owner Einstellungen', ageEnabled: await isAgeRestrictionEnabled(), registrationCodeEnabled: registrationCode.enabled, registrationCodeValue: await getAppSetting('registration_code') || '', faqs: faqs.rows, success: req.session.settingsSuccess || null });
  req.session.settingsSuccess = null;
});
app.post('/staff/settings/age', requireOwner, async (req, res) => {
  await setAppSetting('age_restriction_enabled', req.body.enabled ? 'true' : 'false');
  await logAudit(req, 'setting_changed', 'app_settings', 'age_restriction_enabled', req.body.enabled ? 'true' : 'false');
  req.session.settingsSuccess = 'Alters-/Kategorie-Sperre gespeichert.';
  res.redirect('/staff/settings');
});

app.post('/staff/settings/registration-code', requireOwner, async (req,res)=>{
  const ageEnabled=await isAgeRestrictionEnabled();
  const enabled=ageEnabled && req.body.enabled==='on';
  await setAppSetting('registration_code_enabled',enabled?'true':'false');
  await setAppSetting('registration_code',String(req.body.registration_code||'').trim());
  await logAudit(req,'setting_changed','app_settings','registration_code_enabled',enabled?'true':'false');
  req.session.settingsSuccess='Registrierungscode-Einstellung gespeichert.';res.redirect('/staff/settings');
});
app.post('/staff/settings/faqs', requireOwner, async (req,res)=>{
  const created=await pool.query('INSERT INTO support_faqs (question,answer,sort_order,active) VALUES ($1,$2,$3,true) RETURNING id',[String(req.body.question||'').slice(0,300),String(req.body.answer||'').slice(0,3000),parseInt(req.body.sort_order||'0',10)||0]);
  await logAudit(req, 'support_faq_created', 'support_faq', created.rows[0].id, req.body.question || '');
  req.session.settingsSuccess='FAQ hinzugefügt.';res.redirect('/staff/settings');
});
app.post('/staff/settings/faqs/:id', requireOwner, async (req,res)=>{
  await pool.query('UPDATE support_faqs SET question=$1,answer=$2,sort_order=$3,active=$4 WHERE id=$5',[String(req.body.question||'').slice(0,300),String(req.body.answer||'').slice(0,3000),parseInt(req.body.sort_order||'0',10)||0,req.body.active==='on',req.params.id]);
  await logAudit(req, 'support_faq_updated', 'support_faq', req.params.id, req.body.question || '');
  req.session.settingsSuccess='FAQ gespeichert.';res.redirect('/staff/settings');
});
app.get('/staff/legal', requireOwner, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM legal_pages ORDER BY title');
  res.render('staff-legal', { title: 'Rechtliche Seiten', pages: rows, success: req.session.legalSuccess || null });
  req.session.legalSuccess = null;
});
app.post('/staff/legal/:slug', requireOwner, async (req, res) => {
  await pool.query('UPDATE legal_pages SET title=$1, body=$2, updated_by=$3, updated_at=now() WHERE slug=$4', [req.body.title || '', req.body.body || '', res.locals.user.id, req.params.slug]);
  await logAudit(req, 'legal_page_updated', 'legal_page', req.params.slug, req.body.title || '');
  req.session.legalSuccess = 'Seite gespeichert.';
  res.redirect('/staff/legal');
});
app.get('/staff/audit', requireOwner, async (req, res) => {
  const { rows } = await pool.query('SELECT a.*, u.full_name, u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 300');
  res.render('staff-audit', { title: 'Audit Log', logs: rows });
});

app.get('/bewertungen', async (_, res) => {
  const { rows } = await pool.query('SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 50');
  res.render('reviews', { title: 'Bewertungen', reviews: rows });
});

app.get('/health', (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Premium Shop läuft auf Port ${port}`);
  if (cloudinaryConfigured) {
    console.log('[Cloudinary] Bildspeicher ist aktiv. Produktbilder werden dauerhaft bei Cloudinary gespeichert.');
  } else {
    console.warn(`[Cloudinary] Nicht aktiv. Fehlende Variablen: ${cloudinaryMissingKeys.join(', ')}. Uploads werden blockiert, außer LOCAL_IMAGE_FALLBACK=true ist gesetzt.`);
  }
  if (mailersendConfigured) console.log('[Mail] MailerSend API ist aktiv.');
  else if (smtpConfigured) console.log('[Mail] SMTP ist aktiv.');
  else console.warn('[Mail] Nicht aktiv. Setze MAILERSEND_API_KEY und MAIL_FROM.');
});
