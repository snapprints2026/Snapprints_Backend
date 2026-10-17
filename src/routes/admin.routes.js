const express = require("express");
const router = express.Router();

const admin = require("../controllers/admin.controller");
const issue = require("../controllers/issue.controller");
const { verifyAdminToken } = require("../middleware/verifyStaffToken");

/* ── Existing routes (unchanged) ──
   NOTE: these are currently NOT auth-protected. Once your admin frontend
   is sending a Bearer token, add `verifyAdminToken,` as the 2nd arg to each
   of these too — same as the new routes below. */
router.get("/stats", admin.getStats);
router.post("/createmachine", admin.createMachine);
router.get("/machines", admin.getMachines);
router.get("/alerts", admin.getAlerts);
router.get("/live-jobs", admin.getLiveJobs);
router.get("/revenue", admin.getRevenue);
router.get("/machineinfo", admin.getMachineInfo);
router.get("/machine-report/:machineId", admin.machineReport);
router.put("/machines/:machineId", admin.updateMachine);
router.delete("/machines/:machineId", admin.deleteMachine);

/* ── Vendor management ── */
router.post("/vendors", verifyAdminToken, admin.createVendor);
router.get("/vendors", verifyAdminToken, admin.getVendors);
router.get("/vendors/:vendorId", verifyAdminToken, admin.getVendorDetail);

/* ── Customers ── */
router.get("/customers", verifyAdminToken, admin.getCustomers);
router.get("/customers/:customerId", verifyAdminToken, admin.getCustomerDetail);

/* ── Machine ↔ vendor assignment ── */
router.patch("/machines/:machineId/assign", verifyAdminToken, admin.assignMachineToVendor);
router.patch("/machines/:machineId/unassign", verifyAdminToken, admin.unassignMachine);
router.get("/machines/:machineId/jobs", verifyAdminToken, admin.getMachineJobs);

/* ── Manual refunds (for stuck/expired jobs the auto-refund flow never caught) ── */
router.post("/jobs/:jobId/refund", verifyAdminToken, admin.refundJob);
/* ── Customer issues ("paid but no print") + support search ── */
router.get("/issues", verifyAdminToken, issue.listIssues);
router.patch("/issues/:issueId", verifyAdminToken, issue.resolveIssue);
router.get("/jobs/search", verifyAdminToken, issue.searchJobs);
router.post("/jobs/:jobId/issue", verifyAdminToken, issue.openIssueForJob);

/* ── Withdrawals (approve / reject / mark paid) ── */
router.get("/withdrawals", verifyAdminToken, admin.getWithdrawals);
router.patch("/withdrawals/:withdrawalId", verifyAdminToken, admin.updateWithdrawalStatus);

/* ── Platform-wide revenue overview ── */
router.get("/revenue-overview", verifyAdminToken, admin.getRevenueOverview);

module.exports = router;