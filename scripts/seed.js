require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
  const email = process.env.STAFF_EMAIL || 'staff@example.com';
  const password = process.env.STAFF_PASSWORD || 'ChangeMe123!';
  const hash = await bcrypt.hash(password, 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, street, postal_code, city, phone, role)
    VALUES ($1,$2,'Shop Personal','-', '-', '-', '', 'staff')
    ON CONFLICT (email) DO UPDATE SET role='staff'
  `, [email, hash]);

  await pool.query(`
    INSERT INTO products (name, description, price_cents, discount_percent, stock, image_url)
    VALUES
      ('Beispielprodukt', 'Dieses Produkt kannst du im Staff-Bereich bearbeiten oder löschen.', 499, 0, 10, NULL)
    ON CONFLICT DO NOTHING
  `);
  console.log('Seed fertig. Staff:', email, 'Passwort:', password);
  await pool.end();
})();
