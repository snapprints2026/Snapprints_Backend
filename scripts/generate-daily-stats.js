// scripts/generate-daily-stats.js
// Usage: node scripts/generate-daily-stats.js
// Uses the same DB settings as the server (no hard-coded credentials).
require("../src/config/env");
const db = require("../src/database/db");

(async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const dateString = yesterday.toISOString().split("T")[0];

  const [rows] = await db.query(`
    SELECT 
      machine_id,
      COUNT(*) as total_jobs,
      SUM(total_pages * copies) as total_pages,
      SUM(amount) as total_revenue
    FROM print_jobs
    WHERE status='PRINTED'
      AND DATE(created_at)=?
    GROUP BY machine_id
  `, [dateString]);

  for (const row of rows) {
    await db.query(`
      INSERT INTO machine_stats_daily
      (machine_id, date, total_jobs, total_pages, total_revenue)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        total_jobs=?,
        total_pages=?,
        total_revenue=?
    `, [
      row.machine_id,
      dateString,
      row.total_jobs || 0,
      row.total_pages || 0,
      row.total_revenue || 0,
      row.total_jobs || 0,
      row.total_pages || 0,
      row.total_revenue || 0
    ]);
  }

  console.log("Daily stats generated");
  await db.end();
  process.exit(0);
})();
