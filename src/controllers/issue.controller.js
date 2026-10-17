// src/controllers/issue.controller.js
// "Paid but didn't get my print" — customer reports + admin review queue.
//
// Customer:  POST /api/jobs/:jobId/report        { reason, details }
// Admin:     GET  /api/admin/issues?status=OPEN
//            PATCH /api/admin/issues/:issueId    { action: "APPROVE" | "REJECT", note }
//            GET  /api/admin/jobs/search?q=...   (ref code, UTR, phone, job id, payment id)
const db = require("../database/db");
const env = require("../config/env");
const { jobOwnerFilter } = require("../middleware/verifyCustomerToken");
const { refundJob } = require("../services/refund.service");

const REASONS = new Set(["NOTHING_PRINTED", "MISSING_PAGES", "BAD_QUALITY", "MACHINE_ERROR", "OTHER"]);
const PAID_STATUSES = ["PAID", "PRINTING", "PRINTED", "FAILED", "EXPIRED"];

/* ───────────────────────── Customer ───────────────────────── */

/* POST /api/jobs/:jobId/report   { reason, details }
   → { issueStatus, refundStatus?, message } */
exports.reportIssue = async (req, res) => {
  try {
    const { jobId } = req.params;
    const reason = REASONS.has(req.body.reason) ? req.body.reason : "OTHER";
    const details = req.body.details ? String(req.body.details).trim().slice(0, 500) : null;

    const owner = jobOwnerFilter(req);
    const [[job]] = await db.query(
      `SELECT job_id, status, payment_id, refund_status, created_at,
              (created_at > NOW() - INTERVAL ? HOUR) AS within_window
       FROM print_jobs WHERE job_id=? AND ${owner.sql}`,
      [env.ISSUE_REPORT_WINDOW_HOURS, jobId, ...owner.params]
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.payment_id || !PAID_STATUSES.includes(job.status))
      return res.status(400).json({ error: "This job was not paid, so there is nothing to refund." });

    // Already refunded (or refund in progress) — just tell them.
    if (job.refund_status && job.refund_status !== "FAILED") {
      return res.json({
        issueStatus: "AUTO_APPROVED",
        refundStatus: job.refund_status,
        message: "Your refund has already been started. It reaches your account in 5–7 working days.",
      });
    }

    // OTP not used yet — nothing has gone wrong yet.
    if (job.status === "PAID") {
      return res.status(400).json({
        error: `Your OTP is still valid — enter it on the machine. If it isn't used within ${env.OTP_TTL_MINUTES} minutes of payment, you are refunded automatically.`,
      });
    }

    if (!Number(job.within_window))
      return res.status(400).json({ error: `Problems can be reported up to ${env.ISSUE_REPORT_WINDOW_HOURS} hours after printing.` });

    // One report per job
    const [[existing]] = await db.query(`SELECT status FROM job_issues WHERE job_id=?`, [jobId]);
    if (existing) {
      return res.json({ issueStatus: existing.status, message: messageFor(existing.status) });
    }

    // FAILED / EXPIRED = the system already knows printing didn't happen → refund now.
    // PRINTING / PRINTED = the kiosk says it printed (or is still printing) → admin checks.
    const autoApprove = job.status === "FAILED" || job.status === "EXPIRED";

    await db.query(
      `INSERT INTO job_issues (job_id, source, reason, details, status) VALUES (?, 'CUSTOMER', ?, ?, ?)`,
      [jobId, reason, details, autoApprove ? "AUTO_APPROVED" : "OPEN"]
    );

    if (autoApprove) {
      try {
        const r = await refundJob(jobId, { reason: `ISSUE_${reason}` });
        await db.query(`UPDATE job_issues SET resolved_at=NOW(), resolution_note='Auto refund' WHERE job_id=?`, [jobId]);
        return res.json({ issueStatus: "AUTO_APPROVED", refundStatus: r.refundStatus, message: messageFor("AUTO_APPROVED") });
      } catch (e) {
        // Refund call failed — leave it for an admin instead of losing it
        await db.query(`UPDATE job_issues SET status='OPEN', resolution_note=? WHERE job_id=?`, [e.message.slice(0, 500), jobId]);
        return res.json({ issueStatus: "OPEN", message: messageFor("OPEN") });
      }
    }

    return res.json({ issueStatus: "OPEN", message: messageFor("OPEN") });
  } catch (err) {
    console.error("REPORT ISSUE ERROR:", err);
    res.status(500).json({ error: "Could not send your report. Please try again." });
  }
};

function messageFor(status) {
  switch (status) {
    case "AUTO_APPROVED":
    case "APPROVED":
      return "Refund approved. It reaches your original payment method in 5–7 working days.";
    case "REJECTED":
      return "We checked this job and the machine confirmed it printed correctly, so no refund was made.";
    default:
      return "Thanks — we've received your report. Our team will check the machine and refund you within 24 hours if it didn't print.";
  }
}

/* ───────────────────────── Admin ───────────────────────── */

const JOB_FIELDS = `
  pj.job_id, pj.ref_code, pj.machine_id, pj.file_name, pj.total_pages, pj.copies, pj.color,
  pj.print_side, pj.amount, pj.status AS job_status, pj.payment_id, pj.payment_method,
  pj.utr, pj.payer_contact, pj.refund_id, pj.refund_status, pj.refund_amount, pj.refund_reason,
  pj.created_at AS job_created_at, pj.updated_at AS job_updated_at, pj.printed_at,
  m.name AS machine_name, c.phone AS customer_phone, c.name AS customer_name`;

/* Timeline of a job from audit_logs: unlocked, printed, failed, refunds… */
async function loadEvents(jobIds) {
  if (!jobIds.length) return {};
  const [rows] = await db.query(
    `SELECT job_id, action_type, details, created_at FROM audit_logs
     WHERE job_id IN (?) ORDER BY created_at ASC`,
    [jobIds]
  );
  const byJob = {};
  for (const r of rows) {
    let details = r.details;
    if (typeof details === "string") {
      try { details = JSON.parse(details); } catch { /* keep string */ }
    }
    const label = (details && details.event) || r.action_type;
    (byJob[r.job_id] ||= []).push({ event: label, at: r.created_at, details });
  }
  return byJob;
}

/* GET /api/admin/issues?status=OPEN|APPROVED|REJECTED|AUTO_APPROVED|ALL */
exports.listIssues = async (req, res) => {
  try {
    const status = String(req.query.status || "OPEN").toUpperCase();
    const where = status === "ALL" ? "1=1" : "ji.status=?";
    const params = status === "ALL" ? [] : [status];

    const [rows] = await db.query(
      `SELECT ji.id, ji.job_id, ji.source, ji.reason, ji.details, ji.status, ji.resolution_note,
              ji.resolved_at, ji.created_at, ${JOB_FIELDS}
       FROM job_issues ji
       JOIN print_jobs pj ON pj.job_id = ji.job_id
       LEFT JOIN machines m ON m.machine_id = pj.machine_id
       LEFT JOIN customers c ON c.id = pj.customer_id
       WHERE ${where}
       ORDER BY ji.created_at DESC
       LIMIT 200`,
      params
    );
    const events = await loadEvents(rows.map((r) => r.job_id));
    res.json(rows.map((r) => ({ ...r, events: events[r.job_id] || [] })));
  } catch (err) {
    console.error("LIST ISSUES ERROR:", err);
    res.status(500).json({ error: "Failed to load issues" });
  }
};

/* PATCH /api/admin/issues/:issueId   { action: "APPROVE" | "REJECT", note } */
exports.resolveIssue = async (req, res) => {
  try {
    const action = String(req.body.action || "").toUpperCase();
    const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
    if (!["APPROVE", "REJECT"].includes(action))
      return res.status(400).json({ error: "action must be APPROVE or REJECT" });

    const [[issue]] = await db.query(`SELECT * FROM job_issues WHERE id=?`, [req.params.issueId]);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    if (issue.status !== "OPEN") return res.status(409).json({ error: `Issue is already ${issue.status}` });

    let refund = null;
    if (action === "APPROVE") {
      try {
        refund = await refundJob(issue.job_id, { reason: `ISSUE_${issue.reason}`, adminId: req.staff.id });
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
      }
    }

    await db.query(
      `UPDATE job_issues SET status=?, resolution_note=?, resolved_by=?, resolved_at=NOW()
       WHERE id=? AND status='OPEN'`,
      [action === "APPROVE" ? "APPROVED" : "REJECTED", note, req.staff.id, issue.id]
    );
    res.json({ success: true, refund });
  } catch (err) {
    console.error("RESOLVE ISSUE ERROR:", err);
    res.status(500).json({ error: "Failed to update issue" });
  }
};

/* GET /api/admin/jobs/search?q=SP-7KQ2MX | UTR | 98xxxxxxxx | JOB_… | pay_…
   For a customer who calls/WhatsApps support without logging in. */
exports.searchJobs = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 4) return res.status(400).json({ error: "Type at least 4 characters" });

    const upper = q.toUpperCase();
    const refCode = upper.startsWith("SP-") ? upper : `SP-${upper}`;
    const phone = q.replace(/\D/g, "").slice(-10);

    const [rows] = await db.query(
      `SELECT ${JOB_FIELDS}, ji.id AS issue_id, ji.status AS issue_status
       FROM print_jobs pj
       LEFT JOIN machines m ON m.machine_id = pj.machine_id
       LEFT JOIN customers c ON c.id = pj.customer_id
       LEFT JOIN job_issues ji ON ji.job_id = pj.job_id
       WHERE pj.job_id = ? OR pj.ref_code = ? OR pj.utr = ? OR pj.payment_id = ?
          OR (? <> '' AND LENGTH(?) = 10 AND (pj.payer_contact = ? OR c.phone = ?))
       ORDER BY pj.created_at DESC
       LIMIT 50`,
      [q, refCode, q, q, phone, phone, phone, phone]
    );
    const events = await loadEvents(rows.map((r) => r.job_id));
    res.json(rows.map((r) => ({ ...r, events: events[r.job_id] || [] })));
  } catch (err) {
    console.error("SEARCH JOBS ERROR:", err);
    res.status(500).json({ error: "Search failed" });
  }
};

/* POST /api/admin/jobs/:jobId/issue — admin opens a case for a job found by search
   (customer called support instead of using the app). */
exports.openIssueForJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const reason = REASONS.has(req.body.reason) ? req.body.reason : "OTHER";
    const details = req.body.details ? String(req.body.details).slice(0, 500) : "Reported to support";
    const [[job]] = await db.query(`SELECT job_id, payment_id FROM print_jobs WHERE job_id=?`, [jobId]);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.payment_id) return res.status(400).json({ error: "This job was never paid" });

    await db.query(
      `INSERT IGNORE INTO job_issues (job_id, source, reason, details, status) VALUES (?, 'CUSTOMER', ?, ?, 'OPEN')`,
      [jobId, reason, details]
    );
    const [[issue]] = await db.query(`SELECT id, status FROM job_issues WHERE job_id=?`, [jobId]);
    res.json(issue);
  } catch (err) {
    console.error("OPEN ISSUE ERROR:", err);
    res.status(500).json({ error: "Could not open the case" });
  }
};