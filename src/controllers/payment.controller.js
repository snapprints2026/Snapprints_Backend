// src/controllers/payment.controller.js
const crypto = require("crypto");
const db = require("../database/db");
const { getIO, machineRoom } = require("../socket/socket");
const { calculatePrice } = require("../services/pricing.service");
const payment = require("../services/payment.service");
const { jobOwnerFilter } = require("../middleware/verifyCustomerToken");

const OTP_TTL_MS = 5 * 60 * 1000;
const generateOTP = () => crypto.randomInt(1000, 10000).toString();     // 4-digit kiosk OTP
const generateQrToken = () => crypto.randomBytes(32).toString("hex");

/* POST /api/create-payment   { jobId }   (customer token required unless demo mode) */
exports.createPayment = async (req, res) => {
  if (!payment.isEnabled()) return res.status(503).json({ error: "Payment service unavailable" });
  try {
    const { jobId } = req.body;
    const owner = jobOwnerFilter(req);
    const [[job]] = await db.query(
      `SELECT * FROM print_jobs WHERE job_id=? AND ${owner.sql} AND status='CREATED'`,
      [jobId, ...owner.params]
    );
    if (!job) return res.status(409).json({ error: "Invalid job state" });
    if (!job.file_path || !(job.total_pages > 0))
      return res.status(409).json({ error: "Upload not finished yet" });

    const [[machine]] = await db.query(
      `SELECT is_print_locked FROM machines WHERE machine_id=?`, [job.machine_id]
    );
    if (!machine) return res.status(404).json({ error: "Machine not found" });
    if (machine.is_print_locked)
      return res.status(400).json({ error: "Machine out of paper. Payment disabled." });

    const price = calculatePrice(job);
    const amount = Math.round(price.paise);
    const order = await payment.createOrder(amount, jobId);

    await db.query(
      `UPDATE print_jobs SET amount=?, payment_order_id=?, status='PAYING' WHERE job_id=?`,
      [price.total, order.id, jobId]
    );
    res.json({ key: payment.keyId, amount, orderId: order.id });
  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment creation failed" });
  }
};

/* POST /api/verify-payment   { razorpay_order_id, razorpay_payment_id, razorpay_signature } */
exports.verifyPayment = async (req, res) => {
  if (!payment.isEnabled()) return res.status(503).json({ error: "Payment service unavailable" });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: "Missing payment fields" });

  if (!payment.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature))
    return res.status(400).json({ error: "Invalid signature" });

  // Fetch method before taking row locks (network call)
  const { method, details } = await payment.fetchPaymentMethod(razorpay_payment_id);

  const connection = await db.getConnection();
  let txStarted = false;
  try {
    await connection.beginTransaction();
    txStarted = true;

    const [rows] = await connection.query(
      `SELECT * FROM print_jobs WHERE payment_order_id=? FOR UPDATE`, [razorpay_order_id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(400).json({ error: "Job not found" });
    }

    const job = rows[0];
    if (job.status !== "PAYING") {
      await connection.rollback();
      return res.status(409).json({ error: "Already processed" });
    }

    const otp = generateOTP();
    const qr = generateQrToken();
    const expiry = new Date(Date.now() + OTP_TTL_MS);

    await connection.query(
      `UPDATE print_jobs
       SET status='PAID', payment_id=?, payment_method=?, payment_details=?, updated_at=NOW()
       WHERE id=?`,
      [razorpay_payment_id, method, details ? JSON.stringify(details) : null, job.id]
    );

    await connection.query(
      `INSERT INTO print_job_tokens (job_id, otp, otp_verified, otp_expires_at, qr_token, qr_expires_at)
       VALUES (?, ?, 0, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         otp=VALUES(otp), otp_verified=0, otp_expires_at=VALUES(otp_expires_at),
         qr_token=VALUES(qr_token), qr_expires_at=VALUES(qr_expires_at)`,
      [job.job_id, otp, expiry, qr, expiry]
    );

    await connection.commit();
    txStarted = false;

    // Notify only after commit. No file paths in any event.
    const event = { jobId: job.job_id, machineId: job.machine_id };
    getIO().to(machineRoom(job.machine_id)).emit("payment_success", event); // that kiosk
    getIO().emit("payment_success", event);                                  // dashboards / customer page

    return res.json({ success: true, otp, qrToken: qr });
  } catch (err) {
    if (txStarted) await connection.rollback().catch(() => {});
    console.error("VERIFY PAYMENT ERROR:", err);
    return res.status(500).json({ error: "Payment verification failed" });
  } finally {
    connection.release();
  }
};
