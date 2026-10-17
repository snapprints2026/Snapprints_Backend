// src/jobs/cleanup.cron.js
// Runs every 5 minutes:
//  1. Unpaid jobs (CREATED) older than 30 min → file + row deleted (abandoned uploads)
//  2. Paid jobs whose OTP/QR expired unused   → marked EXPIRED (row kept, refundable by admin)
//  3. Any job file older than UPLOAD_MAX_AGE_MINUTES is deleted from R2,
//     unless the job is PRINTING or PAID with a still-valid OTP.
// PRINTED / FAILED / EXPIRED job rows are NEVER deleted — dashboards need them.
//
// Files are found through the database (no "list bucket" calls — those cost money
// on R2, deletes are free). The bucket's lifecycle rule (delete after 1 day)
// catches anything this misses, e.g. if the server was down.
const cron = require("node-cron");
const db = require("../database/db");
const env = require("../config/env");
const { deleteJobFile } = require("../services/file.service");
const { refundJob } = require("../services/refund.service");

const BATCH = 500;

async function removeAbandonedJobs() {
  const [rows] = await db.query(
    `SELECT job_id, file_path FROM print_jobs
     WHERE status='CREATED' AND created_at < NOW() - INTERVAL 30 MINUTE
     LIMIT ${BATCH}`
  );
  for (const r of rows) {
    const ok = await deleteJobFile(r.job_id, r.file_path);
    if (ok) await db.query(`DELETE FROM print_jobs WHERE job_id=? AND status='CREATED'`, [r.job_id]);
  }
  return rows.length;
}

async function expireJobs() {
  const [rows] = await db.query(
    `SELECT pj.job_id
     FROM print_jobs pj
     INNER JOIN print_job_tokens pjt ON pj.job_id = pjt.job_id
     WHERE pj.status='PAID' AND pjt.otp_verified=0 AND pjt.otp_expires_at < NOW()
     LIMIT ${BATCH}`
  );
  for (const { job_id } of rows) {
    const [r] = await db.query(
      `UPDATE print_jobs SET status='EXPIRED', updated_at=NOW() WHERE job_id=? AND status='PAID'`,
      [job_id]
    );
    if (r.affectedRows) await safeRefund(job_id, "OTP_EXPIRED");
  }
  await db.query(`DELETE FROM print_job_tokens WHERE otp_expires_at < NOW() AND otp_verified=0`);

  // Safety net: EXPIRED jobs from the last 7 days that never got a refund
  // (e.g. Razorpay was down, or the server restarted mid-way).
  const [missed] = await db.query(
    `SELECT job_id FROM print_jobs
     WHERE status='EXPIRED' AND payment_id IS NOT NULL AND refund_status IS NULL
       AND updated_at > NOW() - INTERVAL 7 DAY
     LIMIT 100`
  );
  for (const { job_id } of missed) await safeRefund(job_id, "OTP_EXPIRED");
  return rows.length;
}

async function safeRefund(jobId, reason) {
  try {
    const r = await refundJob(jobId, { reason });
    if (r.refunded) console.log(`💸 Auto refund ${jobId} (${reason}) → ${r.refundId}`);
  } catch (e) {
    console.error(`AUTO REFUND ERROR ${jobId}:`, e.message);
  }
}

/* PRINTING for > 15 min with no printed/failed report → the kiosk probably
   crashed. Don't refund blindly (it may have printed); open a case instead. */
async function flagStuckJobs() {
  const [r] = await db.query(
    `INSERT IGNORE INTO job_issues (job_id, source, reason, details, status)
     SELECT job_id, 'SYSTEM', 'STUCK', 'Kiosk did not confirm printed/failed within 15 minutes', 'OPEN'
     FROM print_jobs
     WHERE status='PRINTING' AND updated_at < NOW() - INTERVAL 15 MINUTE
     LIMIT ${BATCH}`
  );
  return r.affectedRows;
}

async function safeRefund(jobId, reason) {
  try {
    const r = await refundJob(jobId, { reason });
    if (r.refunded) console.log(`💸 Auto refund ${jobId} (${reason}) → ${r.refundId}`);
  } catch (e) {
    console.error(`AUTO REFUND ERROR ${jobId}:`, e.message);
  }
}

/* PRINTING for > 15 min with no printed/failed report → the kiosk probably
   crashed. Don't refund blindly (it may have printed); open a case instead. */
async function flagStuckJobs() {
  const [r] = await db.query(
    `INSERT IGNORE INTO job_issues (job_id, source, reason, details, status)
     SELECT job_id, 'SYSTEM', 'STUCK', 'Kiosk did not confirm printed/failed within 15 minutes', 'OPEN'
     FROM print_jobs
     WHERE status='PRINTING' AND updated_at < NOW() - INTERVAL 15 MINUTE
     LIMIT ${BATCH}`
  );
  return r.affectedRows;
}

async function removeOldFiles() {
  const [rows] = await db.query(
    `SELECT pj.job_id, pj.file_path
     FROM print_jobs pj
     LEFT JOIN print_job_tokens pjt ON pj.job_id = pjt.job_id
     WHERE pj.file_path IS NOT NULL
       AND pj.created_at < NOW() - INTERVAL ? MINUTE
       AND NOT (pj.status='PRINTING' OR (pj.status='PAID' AND pjt.otp_expires_at > NOW()))
     LIMIT ${BATCH}`,
    [env.UPLOAD_MAX_AGE_MINUTES]
  );
  let deleted = 0;
  for (const r of rows) if (await deleteJobFile(r.job_id, r.file_path)) deleted++;
  return deleted;
}

async function runCleanup() {
  try {
    const n = await removeAbandonedJobs();
    if (n) console.log(`🧹 Removed ${n} abandoned upload(s)`);
  } catch (err) {
    console.error("CLEANUP ABANDONED ERROR:", err);
  }
   try {
    const n = await expireJobs();
    if (n) console.log(`⌛ Expired ${n} unused OTP job(s)`);
  } catch (err) {
    console.error("CLEANUP JOBS ERROR:", err);
  }
  try {
    const n = await flagStuckJobs();
    if (n) console.log(`⚠️  Flagged ${n} stuck job(s) for review`);
  } catch (err) {
    console.error("STUCK JOBS ERROR:", err);
  }
  try {
    const n = await removeOldFiles();
    if (n) console.log(`🧹 Deleted ${n} old file(s)`);
  } catch (err) {
    console.error("CLEANUP FILES ERROR:", err);
  }
}

function startCleanupCron() {
  cron.schedule("*/5 * * * *", runCleanup);
  console.log("✅ Cleanup cron scheduled (every 5 min)");
}

module.exports = { startCleanupCron, runCleanup };
