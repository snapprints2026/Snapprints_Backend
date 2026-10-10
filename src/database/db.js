require("../config/env"); // make sure .env is loaded first
const mysql = require("mysql2/promise");


const db = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE,
  port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || "3306"),
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection (non-blocking)
(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ DB Connected");
    conn.release();
  } catch (err) {
    console.error("❌ DB Connection Failed:", err.message);
  }
})();

(async () => {
  try {
    const [rows] = await db.query("SELECT DATABASE() AS current_db");
    console.log("CURRENT DATABASE:", rows[0].current_db);
  } catch (e) {
    console.error("DATABASE TEST ERROR:", e);
  }
})();

module.exports = db;