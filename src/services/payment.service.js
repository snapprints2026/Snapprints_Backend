// src/services/payment.service.js
// Razorpay order / signature / payment-method / refund logic.
const crypto = require("crypto");
const razorpay = require("../config/razorpay");
const env = require("../config/env");

function isEnabled() {
  return !!razorpay;
}

async function createOrder(amountPaise, jobId) {
  // Razorpay receipts are max 40 chars
  const receipt = `${jobId}_${Date.now()}`.slice(0, 40);
  return razorpay.orders.create({ amount: amountPaise, currency: "INR", receipt });
}

function verifySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Payment method isn't in the checkout callback — fetch it. Non-fatal. */
async function fetchPaymentMethod(paymentId) {
  if (!razorpay) return { method: null, details: null };
  try {
    const p = await razorpay.payments.fetch(paymentId);
    const method = p.method || null; // upi | card | netbanking | wallet | emi
    let details = null;
    if (method === "upi" && p.vpa) details = { vpa: p.vpa };
    else if (method === "card" && p.card)
      details = { network: p.card.network || null, last4: p.card.last4 || null, type: p.card.type || null };
    else if (method === "netbanking" && p.bank) details = { bank: p.bank };
    else if (method === "wallet" && p.wallet) details = { wallet: p.wallet };
    return { method, details };
  } catch (err) {
    console.error("RAZORPAY PAYMENT FETCH ERROR:", err.message);
    return { method: null, details: null };
  }
}

/* amountRupees is what's stored in print_jobs.amount */
async function refund(paymentId, amountRupees) {
  if (!razorpay) throw new Error("Payment service unavailable");
  return razorpay.payments.refund(paymentId, { amount: Math.round(Number(amountRupees) * 100) });
}

module.exports = { isEnabled, createOrder, verifySignature, fetchPaymentMethod, refund, keyId: env.RAZORPAY_KEY_ID };
