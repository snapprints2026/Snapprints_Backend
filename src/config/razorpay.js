// src/config/razorpay.js
// Single shared Razorpay client. `null` when keys are missing —
// callers must check and return 503.
const Razorpay = require("razorpay");
const env = require("./env");

let razorpay = null;

if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.warn("⚠️  Razorpay keys missing — payment routes disabled");
}

module.exports = razorpay;
