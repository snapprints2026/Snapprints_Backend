// routes/vendor.routes.js
const express = require("express");
const router  = express.Router();

const vendor  = require("../controllers/vendor.controller");
const { verifyVendorToken } = require("../middleware/verifyStaffToken");

// Every route below requires a valid vendor JWT.
router.use(verifyVendorToken);

router.get("/me", vendor.getMe);

router.get("/machines", vendor.getMyMachines);
router.get("/machines/:machineId/revenue", vendor.getMachineRevenue);

router.get("/revenue-summary", vendor.getRevenueSummary);
router.get("/balance", vendor.getAvailableBalance);

router.get("/bank-account", vendor.getBankAccount);
router.post("/bank-account", vendor.upsertBankAccount);

router.get("/withdrawals", vendor.getMyWithdrawals);
router.post("/withdrawals", vendor.requestWithdrawal);

module.exports = router;