// routes/auth.routes.js
const express = require("express");
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcrypt");
const router  = express.Router();
const db      = require("../database/db");

const crypto  = require("crypto");
const generateOTP = () => crypto.randomInt(100000, 1000000).toString(); // 6-digit
//const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/* ── Placeholder SMS sender — wire up your SMS gateway here ── */
async function sendOtpSms(mobile, otp) {
  // TODO: replace with real gateway, e.g. MSG91 / Twilio:
  // await fetch("https://api.msg91.com/api/v5/otp", { ... });
  console.log(`[SMS MOCK] OTP ${otp} → +91${mobile}`);
}

function issueToken(customer, mobile) {
  return jwt.sign(
    { customerId: customer.id, mobile, role: "customer" },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

/* ═══════════════════════════════════════════════════════════
   POST /api/auth/admin/login
   body: { email, password }
═══════════════════════════════════════════════════════════ */
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const cleanEmail = email.trim().toLowerCase();

    const [[admin]] = await db.query(
      `SELECT * FROM admin_users WHERE email=? AND status='ACTIVE'`, [cleanEmail]
    );
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin.id, role: "admin", name: admin.name, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: { id: admin.id, name: admin.name, email: admin.email, role: "admin" },
    });
  } catch (err) {
    console.error("ADMIN LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/auth/vendor/login
   body: { email, password }
═══════════════════════════════════════════════════════════ */
router.post("/vendor/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const cleanEmail = email.trim().toLowerCase();

    const [[vendor]] = await db.query(
      `SELECT * FROM vendors WHERE email=? AND status='ACTIVE'`, [cleanEmail]
    );
    if (!vendor) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, vendor.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: vendor.id, role: "vendor", name: vendor.full_name, email: vendor.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: vendor.id,
        name: vendor.full_name,
        email: vendor.email,
        businessName: vendor.business_name,
        role: "vendor",
      },
    });
  } catch (err) {
    console.error("VENDOR LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/auth/login
   body: { mobile }
   Mobile-only login — no name collected up front. Always sends an OTP.
   Returning users on the same device skip this entirely via their saved token.
═══════════════════════════════════════════════════════════ */
router.post("/login", async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile || !MOBILE_REGEX.test(mobile.trim()))
      return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });

    const cleanMobile = mobile.trim();

    const [[existing]] = await db.query(
      `SELECT * FROM customers WHERE phone=?`, [cleanMobile]
    );

    // SECURITY: we always send an OTP here. "Log in without OTP next time"
    // is done by the 30-day token the app saved after the first OTP —
    // the frontend calls /api/customer/me with it and skips this screen.
    // Skipping OTP based on the phone number alone let anyone log in as anyone.

    // ── Send / resend OTP ──
    const otp    = generateOTP();
    const expiry = new Date(Date.now() + OTP_TTL_MS);

    // We no longer collect a name up front. `customers.name` is kept filled
    // with a friendly placeholder so inserts keep working even if that
    // column is NOT NULL — the customer can set a real name later from
    // "My Account". Safe to simplify once/if the column is made nullable.
    const placeholderName = existing?.name || `Cust${cleanMobile.slice(-4)}`;

    await db.query(
      `INSERT INTO customers (name, phone, otp, otp_verified, otp_expires_at)
       VALUES (?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE
         otp=VALUES(otp), otp_verified=0, otp_expires_at=VALUES(otp_expires_at)`,
      [placeholderName, cleanMobile, otp, expiry]
    );

    await sendOtpSms(cleanMobile, otp);

    return res.json({ status: "otp_sent" });
  } catch (err) {
    console.error("AUTH LOGIN ERROR:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/auth/resend-otp
   body: { mobile }
   Always regenerates + resends OTP, regardless of verified state.
═══════════════════════════════════════════════════════════ */
router.post("/resend-otp", async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile || !MOBILE_REGEX.test(mobile.trim()))
      return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });

    const cleanMobile = mobile.trim();

    const [[existing]] = await db.query(`SELECT id FROM customers WHERE phone=?`, [cleanMobile]);
    if (!existing) return res.status(404).json({ error: "No login attempt found for this number" });

    const otp    = generateOTP();
    const expiry = new Date(Date.now() + OTP_TTL_MS);

    await db.query(
      `UPDATE customers SET otp=?, otp_verified=0, otp_expires_at=? WHERE id=?`,
      [otp, expiry, existing.id]
    );

    await sendOtpSms(cleanMobile, otp);
    return res.json({ success: true });
  } catch (err) {
    console.error("AUTH RESEND ERROR:", err);
    return res.status(500).json({ error: "Could not resend OTP" });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/auth/verify-otp
   body: { mobile, otp }
═══════════════════════════════════════════════════════════ */
router.post("/verify-otp", async (req, res) => {
  try {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) return res.status(400).json({ error: "Mobile and OTP are required" });

    const cleanMobile = mobile.trim();

    const [[customer]] = await db.query(`SELECT * FROM customers WHERE phone=?`, [cleanMobile]);
    if (!customer) return res.status(404).json({ error: "No OTP request found for this number" });

    if (!customer.otp || customer.otp !== String(otp).trim())
      return res.status(400).json({ error: "Invalid OTP" });

    if (!customer.otp_expires_at || new Date(customer.otp_expires_at) < new Date())
      return res.status(400).json({ error: "OTP expired. Please request a new one." });

    await db.query(
      `UPDATE customers SET otp_verified=1, otp=NULL, otp_expires_at=NULL WHERE id=?`,
      [customer.id]
    );

    const token = issueToken(customer, cleanMobile);

    return res.json({
      status: "logged_in",
      token,
      user: { name: customer.name, mobile: cleanMobile },
    });
  } catch (err) {
    console.error("AUTH VERIFY ERROR:", err);
    return res.status(500).json({ error: "OTP verification failed" });
  }
});

module.exports = router;