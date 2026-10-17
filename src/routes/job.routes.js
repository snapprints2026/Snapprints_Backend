// src/routes/job.routes.js — customer print jobs (owner only)
const express = require("express");
const router = express.Router();
const job = require("../controllers/job.controller");
const issue = require("../controllers/issue.controller");
// customerAuth = login required at launch, optional in demo mode (REQUIRE_CUSTOMER_LOGIN)
const { customerAuth } = require("../middleware/verifyCustomerToken");

// Upload: the file goes straight from the phone to Cloudflare R2 (see job.controller.js)
router.post ("/upload-url",                    customerAuth, job.createUploadUrl);
router.post ("/jobs/:jobId/complete-upload",   customerAuth, job.completeUpload);
// "Didn't get your print?" — customer reports a problem with a paid job
router.post ("/jobs/:jobId/report",  customerAuth, issue.reportIssue);
router.get  ("/job-summary/:jobId",  customerAuth, job.getSummary);
router.patch("/job/:jobId",          customerAuth, job.updateJob);
router.get  ("/job-status/:jobId",   customerAuth, job.getStatus);

// Old multipart upload (file sent through this server) — replaced by the two routes above
router.post ("/upload-job", (req, res) =>
  res.status(410).json({ error: "Please refresh the page and upload again." }));

module.exports = router;
