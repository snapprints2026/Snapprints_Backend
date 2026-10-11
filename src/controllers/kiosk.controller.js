// src/controllers/kiosk.controller.js
// Endpoints called by the Raspberry Pi kiosks (all signed with verifyMachine,
// except /register-machine which is the first-boot bootstrap).
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const db = require("../database/db");
const env = require("../config/env");
const { getIO } = require("../socket/socket");
const { logAudit } = require("../services/audit.service");
const { deleteJobFile, isStorageKey } = require("../services/file.service");
const storage = require("../services/storage.service");
const payment = require("../services/payment.service");

const fileUrlFor = (jobId) => `/api/kiosk/jobs/${encodeURIComponent(jobId)}/file`;

/* POST /api/kiosk/heartbeat   { cpu_usage, paper_level, ink_level, status } */
exports.heartbeat = async (req, res) => {
  try {
    const machineId = req.machine.machine_id;
    const { cpu_usage, paper_level, ink_level, status } = req.body;

    await db.query(
      `INSERT INTO machine_heartbeat_logs (machine_id, cpu_usage, paper_level, ink_level, status)
       VALUES (?, ?, ?, ?, ?)`,
      [machineId, cpu_usage ?? null, paper_level ?? null, ink_level ?? null, status || "ONLINE"]
    );

    try {
      await db.query(`UPDATE machines SET last_seen_at=NOW(), last_ip=? WHERE machine_id=?`, [req.ip, machineId]);
    } catch {
      await db.query(`UPDATE machines SET last_seen=NOW(), last_ip=? WHERE machine_id=?`, [req.ip, machineId]);
    }

    const lowThreshold = req.machine.paper_threshold || 10;
    const criticalThreshold = req.machine.critical_paper_threshold || 5;

    if (paper_level != null) {
      if (paper_level <= criticalThreshold) {
        await db.query(`UPDATE machines SET is_print_locked=TRUE WHERE machine_id=?`, [machineId]);
      }
      if (paper_level <= lowThreshold) {
        const [[existing]] = await db.query(
          `SELECT id FROM machine_alerts WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );
        if (!existing) {
          await db.query(
            `INSERT INTO machine_alerts (machine_id, alert_type, message) VALUES (?, 'LOW_PAPER', ?)`,
            [machineId, `Paper level is ${paper_level}%`]
          );
        }
      } else {
        await db.query(
          `UPDATE machine_alerts SET is_resolved=TRUE, resolved_at=NOW()
           WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );
      }
    }

    // (Heartbeats are no longer written to audit_logs — they're already in
    //  machine_heartbeat_logs, and logging each one flooded the audit table.)
    getIO().emit("machine_update", { machineId, paper_level, status });
    res.json({ status: "alive" });
  } catch (err) {
    console.error("HEARTBEAT ERROR:", err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
};

/* POST /api/kiosk/unlock   { otp } or { qrToken } */
exports.unlock = async (req, res) => {
  const connection = await db.getConnection();
  let txStarted = false;
  try {
    const { otp, qrToken } = req.body;
    const machineId = req.machine.machine_id;
    if (!otp && !qrToken) return res.status(400).json({ error: "OTP or QR token required" });

    await connection.beginTransaction();
    txStarted = true;
    const now = new Date();

    const [rows] = await connection.query(
      `SELECT pj.*, pjt.otp, pjt.otp_verified, pjt.otp_expires_at, pjt.qr_token, pjt.qr_expires_at
       FROM print_jobs pj
       INNER JOIN print_job_tokens pjt ON pj.job_id = pjt.job_id
       WHERE pj.machine_id=? AND pj.status='PAID' AND pjt.otp_verified=0
         AND (
           (pjt.otp IS NOT NULL AND pjt.otp=? AND pjt.otp_expires_at>?)
           OR
           (pjt.qr_token IS NOT NULL AND pjt.qr_token=? AND pjt.qr_expires_at>?)
         )
       FOR UPDATE`,
      [machineId, otp || null, now, qrToken || null, now]
    );

    if (!rows.length) {
      await connection.rollback();
      txStarted = false;
      await logAudit(machineId, null, "UNLOCK_FAILED", { via: otp ? "otp" : "qr" });
      return res.status(401).json({ error: "Invalid or expired OTP / QR" });
    }

    const job = rows[0];
    await connection.query(`UPDATE print_jobs SET status='PRINTING', updated_at=NOW() WHERE id=?`, [job.id]);
    await connection.query(`UPDATE print_job_tokens SET otp_verified=1 WHERE job_id=?`, [job.job_id]);
    await connection.commit();
    txStarted = false;

    await logAudit(machineId, job.job_id, "JOB_UNLOCKED");

    // Direct Cloudflare R2 link (valid R2_DOWNLOAD_URL_TTL_SECONDS). The Pi just
    // GETs it — no extra headers. Null if the file is already gone.
    let downloadUrl = null;
    if (isStorageKey(job.file_path)) {
      try {
        downloadUrl = await storage.createDownloadUrl(job.file_path, job.file_name);
      } catch (e) {
        console.error("DOWNLOAD URL ERROR:", e.message);
      }
    }

    return res.json({
      jobId: job.job_id,
      downloadUrl,                       // NEW: plain GET straight from R2 (preferred)
      fileUrl: fileUrlFor(job.job_id),   // signed kiosk GET → redirects to R2 (still works)
      fileName: job.file_name,
      filePath: job.file_path,           // kept for older Pi code; do not use for download
      copies: job.copies,
      color: job.color,
      paperSize: job.paper_size,
      printSide: job.print_side,
    });
  } catch (err) {
    if (txStarted) await connection.rollback().catch(() => {});
    console.error("KIOSK UNLOCK ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
};

/* GET /api/kiosk/jobs/:jobId/file — the only way a document leaves storage.
   Checks the kiosk owns the job, then:
     default        → 302 redirect to a short-lived R2 link (most HTTP clients follow it)
     ?format=json   → { url, fileName, expiresIn } so the Pi can GET the link itself */
exports.downloadJobFile = async (req, res) => {
  try {
    const [[job]] = await db.query(
      `SELECT job_id, machine_id, file_name, file_path, status FROM print_jobs WHERE job_id=?`,
      [req.params.jobId]
    );
    if (!job || job.machine_id !== req.machine.machine_id)
      return res.status(404).json({ error: "Job not found" });
    if (!["PAID", "PRINTING"].includes(job.status))
      return res.status(409).json({ error: "Job is not ready for printing" });
    if (!isStorageKey(job.file_path))
      return res.status(410).json({ error: "File no longer available" });

    const info = await storage.getInfo(job.file_path);
    if (!info) return res.status(410).json({ error: "File no longer available" });

    const url = await storage.createDownloadUrl(job.file_path, job.file_name);
    if (req.query.format === "json") {
      return res.json({ url, fileName: job.file_name, expiresIn: env.R2_DOWNLOAD_URL_TTL_SECONDS });
    }
    res.redirect(302, url);
  } catch (err) {
    console.error("DOWNLOAD FILE ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* POST /api/kiosk/mark-printed   { jobId } */
exports.markPrinted = async (req, res) => {
  try {
    const { jobId } = req.body;
    const machineId = req.machine.machine_id;
    if (!jobId) return res.status(400).json({ error: "Job ID required" });

    const [[job]] = await db.query(
      `SELECT file_path, status FROM print_jobs WHERE job_id=? AND machine_id=?`, [jobId, machineId]
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "PRINTING") return res.status(400).json({ error: "Invalid job state" });

    const [result] = await db.query(
      `UPDATE print_jobs SET status='PRINTED', printed_at=NOW()
       WHERE job_id=? AND machine_id=? AND status='PRINTING'`,
      [jobId, machineId]
    );
    if (!result.affectedRows) return res.status(409).json({ error: "State transition failed" });

    await db.query(`DELETE FROM print_job_tokens WHERE job_id=?`, [jobId]);
    await logAudit(machineId, jobId, "JOB_PRINTED");

    // Delete the document; the job row stays for revenue & history.
    await deleteJobFile(jobId, job.file_path);

    getIO().emit("job_printed", { jobId });
    return res.json({ success: true });
  } catch (err) {
    console.error("MARK PRINTED ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/* POST /api/kiosk/mark-failed   { jobId } — auto-refunds */
exports.markFailed = async (req, res) => {
  try {
    const { jobId } = req.body;
    const machineId = req.machine.machine_id;
    if (!jobId) return res.status(400).json({ error: "Job ID required" });

    const [[job]] = await db.query(
      `SELECT payment_id, amount, file_path FROM print_jobs
       WHERE job_id=? AND machine_id=? AND status='PRINTING'`,
      [jobId, machineId]
    );
    if (!job) return res.status(400).json({ error: "Invalid state" });

    const [r] = await db.query(
      `UPDATE print_jobs SET status='FAILED', updated_at=NOW()
       WHERE job_id=? AND machine_id=? AND status='PRINTING'`,
      [jobId, machineId]
    );
    if (!r.affectedRows) return res.status(400).json({ error: "State transition failed" });

    let refundId = null;
    if (payment.isEnabled() && job.payment_id) {
      try {
        const refund = await payment.refund(job.payment_id, job.amount);
        refundId = refund.id;
      } catch (e) {
        console.error("REFUND ERROR:", e.message);
      }
    }

    await logAudit(machineId, jobId, "JOB_FAILED", { refund_id: refundId });
    await deleteJobFile(jobId, job.file_path);
    res.json({ success: true });
  } catch (err) {
    console.error("MARK FAILED ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* GET /api/kiosk/pending-jobs */
exports.pendingJobs = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pj.job_id, pj.file_path
       FROM print_jobs pj
       INNER JOIN print_job_tokens pjt ON pj.job_id = pjt.job_id
       WHERE pj.machine_id=? AND pj.status='PAID'
         AND pjt.otp_verified=0 AND pjt.otp_expires_at > NOW()`,
      [req.machine.machine_id]
    );
    const jobs = rows.map((j) => ({ ...j, file_url: fileUrlFor(j.job_id) }));
    res.json({ jobs });
  } catch (err) {
    console.error("PENDING JOBS ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/* POST /api/register-machine   { deviceSerial } — first boot of a Pi.
   NOTE: still unauthenticated and still returns the stored plain key,
   exactly as before (unchanged so existing Pis keep working). */
exports.registerMachine = async (req, res) => {
  try {
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ error: "Device serial required" });

    const [[existing]] = await db.query(`SELECT * FROM machines WHERE device_serial=?`, [deviceSerial]);

    if (existing) {
      let apiKey = existing.api_key_plain;
      if (!apiKey) {
        apiKey = crypto.randomBytes(32).toString("hex");
        await db.query(
          `UPDATE machines SET api_key_hash=?, api_key_plain=?, last_seen_at=NOW() WHERE machine_id=?`,
          [await bcrypt.hash(apiKey, 10), apiKey, existing.machine_id]
        );
        console.log(`🔑 New key issued for ${existing.machine_id}`);
      }
      return res.json({ MACHINE_ID: existing.machine_id, API_KEY: apiKey, API_BASE: env.API_BASE_URL });
    }

    // A Raspberry Pi may only take a KIOSK machine (SPK…), never a shop
    // computer (SPS…). Oldest first, so SPK1001 is handed out before SPK1002.
    // The UPDATE re-checks assigned=FALSE so two Pis booting at the same
    // moment can't both claim the same machine.
    const apiKey = crypto.randomBytes(32).toString("hex");
    const keyHash = await bcrypt.hash(apiKey, 10);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const [[machine]] = await db.query(
        `SELECT machine_id FROM machines
         WHERE assigned=FALSE AND status='PENDING' AND module='KIOSK'
         ORDER BY id ASC
         LIMIT 1`
      );
      if (!machine) {
        return res.status(400).json({ error: "No available kiosk machines. Create one from the admin panel first." });
      }

      const [claim] = await db.query(
        `UPDATE machines
         SET assigned=TRUE, status='ACTIVE', device_serial=?, api_key_hash=?, api_key_plain=?, last_seen_at=NOW()
         WHERE machine_id=? AND assigned=FALSE`,
        [deviceSerial, keyHash, apiKey, machine.machine_id]
      );
      if (!claim.affectedRows) continue; // another Pi took it a moment ago — try the next one

      console.log(`✅ New machine registered: ${machine.machine_id} (device ${deviceSerial})`);
      return res.json({ MACHINE_ID: machine.machine_id, API_KEY: apiKey, API_BASE: env.API_BASE_URL });
    }

    res.status(409).json({ error: "Could not claim a machine, please retry" });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
};