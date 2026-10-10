// src/routes/payment.routes.js
const express = require("express");
const router = express.Router();
const payment = require("../controllers/payment.controller");
// customerAuth = login required at launch, optional in demo mode (REQUIRE_CUSTOMER_LOGIN)
const { customerAuth } = require("../middleware/verifyCustomerToken");

router.post("/create-payment", customerAuth, payment.createPayment);
// Razorpay's signature proves this request; no customer token needed
router.post("/verify-payment", payment.verifyPayment);

module.exports = router;
