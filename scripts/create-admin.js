// scripts/create-admin.js
// One-off CLI to seed your first admin user, since admins should never
// self-register through a public endpoint.
//
// Usage:
//   node scripts/create-admin.js "Full Name" admin@snapprints.in "StrongPassword123"

require("../src/config/env");
const bcrypt = require("bcrypt");
const db = require("../src/database/db");

async function run() {
  const [name, email, password] = process.argv.slice(2);

  if (!name || !email || !password) {
    console.log('Usage: node scripts/create-admin.js "Full Name" email@x.com password123');
    process.exit(1);
  }

  const cleanEmail = email.trim().toLowerCase();

  const [[existing]] = await db.query(`SELECT id FROM admin_users WHERE email=?`, [cleanEmail]);
  if (existing) {
    console.log(`❌ An admin with email ${cleanEmail} already exists (id=${existing.id})`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  await db.query(
    `INSERT INTO admin_users (name, email, password_hash, status) VALUES (?, ?, ?, 'ACTIVE')`,
    [name, cleanEmail, hash]
  );

  console.log(`✅ Admin created: ${cleanEmail}`);
  process.exit(0);
}

run().catch((err) => {
  console.error("CREATE ADMIN ERROR:", err);
  process.exit(1);
});