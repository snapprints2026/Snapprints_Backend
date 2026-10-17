// src/config/env.js
// Loads .env once and exposes every setting the app needs in one place.
// Secrets are never printed — only whether they are set.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT || "5000", 10),

  // Public URL of this API, handed to Raspberry Pi kiosks on registration
  API_BASE_URL:
    process.env.API_BASE_URL || "https://snapprintsbackend-production.up.railway.app/api",

  JWT_SECRET: process.env.JWT_SECRET,

  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,

  DB_HOST: process.env.DB_HOST || process.env.MYSQLHOST,

  // ── Cloudflare R2 (customer documents) ──
  // Cloudflare dashboard → R2 → your bucket. The endpoint is built from the
  // account ID; R2_ENDPOINT can override it (e.g. a local test server).
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ENDPOINT:
    process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
  R2_FORCE_PATH_STYLE: process.env.R2_FORCE_PATH_STYLE === "true",
  // How long the signed upload / download links work
  R2_UPLOAD_URL_TTL_SECONDS: parseInt(process.env.R2_UPLOAD_URL_TTL_SECONDS || "600", 10),
  R2_DOWNLOAD_URL_TTL_SECONDS: parseInt(process.env.R2_DOWNLOAD_URL_TTL_SECONDS || "600", 10),

  // Files older than this are deleted by the cleanup job (unless still needed)
  UPLOAD_MAX_AGE_MINUTES: parseInt(process.env.UPLOAD_MAX_AGE_MINUTES || "30", 10),

  // Customer OTP login on the upload flow.
  //   false → DEMO MODE: scan QR → upload → pay, no login needed
  //   true  → LAUNCH:    customer must log in (OTP) before uploading
  // Default is true (secure). Set REQUIRE_CUSTOMER_LOGIN=false for the demo.
  REQUIRE_CUSTOMER_LOGIN: process.env.REQUIRE_CUSTOMER_LOGIN !== "false",
    // How long the kiosk OTP works after payment. If it isn't used in time the
  // job becomes EXPIRED and is refunded automatically.
  OTP_TTL_MINUTES: parseInt(process.env.OTP_TTL_MINUTES || "30", 10),

  // Refuse payment when the kiosk hasn't sent a heartbeat in the last 2 minutes.
  // Set to "false" only for testing without a Raspberry Pi.
  REQUIRE_MACHINE_ONLINE: process.env.REQUIRE_MACHINE_ONLINE !== "false",

  // Customers can report a problem with a paid job for this long.
  ISSUE_REPORT_WINDOW_HOURS: parseInt(process.env.ISSUE_REPORT_WINDOW_HOURS || "48", 10),
};

env.R2_ENABLED = !!(env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);

/* ── Validation ── */
if (!env.JWT_SECRET) {
  console.error("❌ JWT_SECRET is not set — logins cannot work. Refusing to start.");
  process.exit(1);
}

console.log("ENV CHECK — DB_HOST:", env.DB_HOST ? "SET" : "MISSING");
console.log("ENV CHECK — RAZORPAY keys:",
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? "SET" : "MISSING (payments disabled)");
if (!env.REQUIRE_CUSTOMER_LOGIN) {
  console.warn("⚠️  DEMO MODE — customer login is OFF (REQUIRE_CUSTOMER_LOGIN=false)");
}
console.log("ENV CHECK — R2 storage:",
  env.R2_ENABLED ? `SET (bucket ${env.R2_BUCKET})` : "MISSING (customers cannot upload files)");

module.exports = env;
