// src/routes/kiosk.routes.js — Raspberry Pi kiosk endpoints
const express = require("express");
const router = express.Router();
const kiosk = require("../controllers/kiosk.controller");
const { verifyMachine } = require("../middleware/verifyMachine");

// First boot of a Pi (no signed headers yet)        → /api/register-machine
router.post("/register-machine", kiosk.registerMachine);

// Signed kiosk requests                             → /api/kiosk/...
router.post("/kiosk/heartbeat",       verifyMachine, kiosk.heartbeat);
router.post("/kiosk/unlock",          verifyMachine, kiosk.unlock);
router.get ("/kiosk/jobs/:jobId/file", verifyMachine, kiosk.downloadJobFile);
router.post("/kiosk/mark-printed",    verifyMachine, kiosk.markPrinted);
router.post("/kiosk/mark-failed",     verifyMachine, kiosk.markFailed);
router.get ("/kiosk/pending-jobs",    verifyMachine, kiosk.pendingJobs);

module.exports = router;
