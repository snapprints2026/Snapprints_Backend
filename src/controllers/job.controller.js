// src/controllers/job.controller.js
// Customer-side job endpoints. A logged-in customer only sees their own jobs;
// in demo mode (REQUIRE_CUSTOMER_LOGIN=false) guests can use their job by its random jobId.
const path = require("path");
const crypto = require("crypto");
const db = require("../database/db");
const env = require("../config/env");
const { getIO } = require("../socket/socket");
const { calculatePrice } = require("../services/pricing.service");
const { getPageCount } = require("../services/pdf.service");
const storage = require("../services/storage.service");
const convert = require("../services/convert.service");
const { deleteJobFile } = require("../services/file.service");
const { jobOwnerFilter } = require("../middleware/verifyCustomerToken");
const { MAX_FILE_SIZE, EXT_TO_MIME, ALLOWED_LABEL } = require("../config/fileTypes");

const MAX_COPIES = 100;
const MAX_NAME_LENGTH = 200;

// "JOB_" + 16 random hex chars (20 chars total) — unguessable, no collisions
const newJobId = () => "JOB_" + crypto.randomBytes(8).toString("hex");

function parseCopies(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_COPIES ? n : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Upload = 3 steps, the file goes straight from the phone to Cloudflare R2:
     1. POST /api/upload-url                 → job row + signed PUT URL
     2. PUT  <uploadUrl>  (browser → R2)       file bytes, Content-Type header
     3. POST /api/jobs/:jobId/complete-upload → size check, page count, price
   Until step 3 succeeds the job has total_pages=0 and cannot be paid.
   ───────────────────────────────────────────────────────────────────────── */

/* POST /api/upload-url
   { fileName, fileSize, machineId, color, copies, paperSize, printSide }
   → { jobId, uploadUrl, contentType, expiresIn } */
exports.createUploadUrl = async (req, res) => {
  try {
    if (!storage.isEnabled()) return res.status(503).json({ error: "Uploads are temporarily unavailable" });

    const { fileName, machineId, color, paperSize, printSide } = req.body;
    const fileSize = Number(req.body.fileSize);
    const copies = parseCopies(req.body.copies);

    if (!fileName || typeof fileName !== "string") return res.status(400).json({ error: "fileName is required" });
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!copies) return res.status(400).json({ error: `Copies must be between 1 and ${MAX_COPIES}` });
    if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: "File is empty" });
    if (fileSize > MAX_FILE_SIZE) return res.status(413).json({ error: "File is larger than 50 MB" });

    const ext = path.extname(fileName).toLowerCase();
    const contentType = EXT_TO_MIME[ext];
    if (!contentType) return res.status(400).json({ error: `Unsupported file type. Allowed: ${ALLOWED_LABEL}` });
        if (!convert.canConvert(ext))
      return res.status(400).json({ error: "Word and text files can't be printed right now. Please save the file as a PDF and upload again." });
    const [[machine]] = await db.query(
      `SELECT machine_id FROM machines WHERE machine_id=? AND status='ACTIVE'`, [machineId]
    );
    if (!machine) return res.status(404).json({ error: "Machine not found" });

    const jobId = newJobId();
    // Random object name; the customer's file name is kept only in the DB.
    const key = `jobs/${jobId}/${crypto.randomBytes(16).toString("hex")}${ext}`;
    const originalName = path.basename(fileName).slice(0, MAX_NAME_LENGTH);

    await db.query(
      `INSERT INTO print_jobs (job_id, machine_id, customer_id, file_name, file_path, color, copies, paper_size, print_side, total_pages, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'CREATED')`,
      [jobId, machineId, req.customer ? req.customer.customerId : null, originalName, key,
       color, copies, paperSize, printSide]
    );

    const uploadUrl = await storage.createUploadUrl(key, contentType);
    res.json({ jobId, uploadUrl, contentType, expiresIn: env.R2_UPLOAD_URL_TTL_SECONDS });
  } catch (err) {
    console.error("UPLOAD URL ERROR:", err);
    res.status(500).json({ error: "Could not start the upload" });
  }
};

/* POST /api/jobs/:jobId/complete-upload   → { jobId, pages }
   Every non-PDF upload is converted to PDF and replaces the original in R2. */
exports.completeUpload = async (req, res) => {
  const { jobId } = req.params;
  try {
    const owner = jobOwnerFilter(req);
    const [[job]] = await db.query(
      `SELECT job_id, machine_id, file_name, file_path, total_pages, status
       FROM print_jobs WHERE job_id=? AND ${owner.sql}`,
      [jobId, ...owner.params]
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "CREATED" || !job.file_path) return res.status(409).json({ error: "Invalid job state" });
    if (job.total_pages > 0) return res.json({ jobId, pages: job.total_pages });

    const originalKey = job.file_path;
    const info = await storage.getInfo(originalKey);
    if (!info) return res.status(400).json({ error: "Upload did not finish. Please try again." });
    if (info.size > MAX_FILE_SIZE) {
      await discardJob(jobId, originalKey);
      return res.status(413).json({ error: "File is larger than 50 MB" });
    }

    const ext = path.extname(originalKey).toLowerCase();
    let pdf;
    let totalPages;
    try {
      const original = await storage.getBuffer(originalKey);
      pdf = await convert.toPdf(original, ext);
      totalPages = await getPageCount(pdf, ".pdf");
    } catch (e) {
      console.error(`CONVERT ERROR (${ext}):`, jobId, e.message);
      await discardJob(jobId, originalKey);
      const msg = ext === ".pdf"
        ? "Could not read this PDF. Is it damaged or password-protected?"
        : "Could not prepare this file for printing. Please save it as a PDF and upload again.";
      return res.status(400).json({ error: msg });
    }
    if (!totalPages || totalPages < 1) totalPages = 1;

    let finalKey = originalKey;
    let finalName = job.file_name;
    if (ext !== ".pdf") {
      finalKey = originalKey.slice(0, -ext.length) + ".pdf";
      finalName = convert.pdfNameFor(job.file_name);
      await storage.put(finalKey, pdf, "application/pdf");
    }

    const [r] = await db.query(
      `UPDATE print_jobs SET total_pages=?, file_path=?, file_name=?, updated_at=NOW()
       WHERE job_id=? AND status='CREATED' AND file_path=? AND total_pages=0`,
      [totalPages, finalKey, finalName, jobId, originalKey]
    );
    if (finalKey !== originalKey && r.affectedRows) {
      try {
        await storage.remove(originalKey); // original photo/Word file no longer needed
      } catch (e) {
        console.error("ORIGINAL DELETE ERROR:", jobId, e.message);
      }
    }
    if (!r.affectedRows) {
      const [[now]] = await db.query(`SELECT total_pages FROM print_jobs WHERE job_id=?`, [jobId]);
      if (now && now.total_pages > 0) return res.json({ jobId, pages: now.total_pages });
      return res.status(409).json({ error: "Invalid job state" });
    }

    getIO().emit("job_created", { jobId, machineId: job.machine_id, pages: totalPages });
    res.json({ jobId, pages: totalPages });
  } catch (err) {
    console.error("COMPLETE UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
};

/* Remove an unusable upload: file + unpaid job row. */
async function discardJob(jobId, key) {
  const [[row]] = await db.query(`SELECT file_path, total_pages FROM print_jobs WHERE job_id=?`, [jobId]);
  if (!row || row.file_path !== key || row.total_pages > 0) return;
  await deleteJobFile(jobId, key);
  await db.query(`DELETE FROM print_jobs WHERE job_id=? AND status='CREATED' AND total_pages=0`, [jobId]);
}
/* GET /api/job-summary/:jobId */
exports.getSummary = async (req, res) => {
  try {
    const owner = jobOwnerFilter(req);
    const [[job]] = await db.query(
      `SELECT * FROM print_jobs WHERE job_id=? AND ${owner.sql}`,
      [req.params.jobId, ...owner.params]
    );
    if (!job) return res.status(404).json({ error: "Job not found" });

    const price = calculatePrice(job);
    res.json({
      pages: job.total_pages, totalPages: job.total_pages, copies: job.copies,
      printSide: job.print_side, color: job.color,
      units: price.units, rate: price.rate, totalAmount: price.total,
    });
  } catch (err) {
    console.error("JOB SUMMARY ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
};

/* PATCH /api/job/:jobId   { color, copies, paperSize, printSide } */
exports.updateJob = async (req, res) => {
  try {
    const { color, paperSize, printSide } = req.body;
    const copies = parseCopies(req.body.copies);
    if (!copies) return res.status(400).json({ error: `Copies must be between 1 and ${MAX_COPIES}` });

    const owner = jobOwnerFilter(req);
    const [r] = await db.query(
      `UPDATE print_jobs SET color=?, copies=?, paper_size=?, print_side=?,
       amount=NULL, payment_order_id=NULL, status='CREATED'
       WHERE job_id=? AND ${owner.sql} AND status IN ('CREATED','PAYING')`,
      [color, copies, paperSize, printSide, req.params.jobId, ...owner.params]
    );
    if (!r.affectedRows) return res.status(409).json({ error: "Job locked" });
    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE JOB ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
};

/* GET /api/job-status/:jobId */
exports.getStatus = async (req, res) => {
  try {
    const owner = jobOwnerFilter(req);
    const [[job]] = await db.query(
      `SELECT status FROM print_jobs WHERE job_id=? AND ${owner.sql}`,
      [req.params.jobId, ...owner.params]
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ status: job.status });
  } catch (err) {
    console.error("JOB STATUS ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
