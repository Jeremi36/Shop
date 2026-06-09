require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
  try {
    const email = (process.env.OWNER_EMAIL || process.env.STAFF_EMAIL || 'owner@example.com').toLowerCase();
    const password = process.env.OWNER_PASSWORD || process.env.STAFF_PASSWORD || 'ChangeMe123!';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`
      INSERT INTO users (email, password_hash, full_name, street, postal_code, city, phone, role, premium)
      VALUES ($1,$2,'Shop Owner','-', '-', '-', '', 'owner', true)
      ON CONFLICT (email) DO UPDATE SET password_hash=$2, role='owner', premium=true
    `, [email, hash]);

    await pool.query(`INSERT INTO categories (name, description) VALUES ('Allgemein','Standard-Kategorie') ON CONFLICT (name) DO NOTHING`);
    await pool.query(`
      INSERT INTO products (name, description, price_cents, discount_percent, stock, image_url, category_id)
      SELECT 'Beispielprodukt', 'Dieses Produkt kannst du im Staff-Bereich bearbeiten oder löschen.', 499, 0, 10, NULL, c.id
      FROM categories c WHERE c.name='Allgemein'
      ON CONFLICT DO NOTHING
    `);
    console.log('Seed fertig. Owner:', email, 'Passwort:', password);
  } catch (err) {
    console.error('Seed fehlgeschlagen:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
