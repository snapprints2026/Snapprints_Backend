// routes/customer.routes.js
const express = require("express");
const router  = express.Router();
const db      = require("../database/db");
const { verifyCustomerToken } = require("../middleware/verifyCustomerToken");

// GET /api/customer/me
router.get("/me", verifyCustomerToken, async (req, res) => {
  try {
    const [[customer]] = await db.query(
      `SELECT name, phone FROM customers WHERE id=?`, [req.customer.customerId]
    );
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json({ name: customer.name, mobile: customer.phone });
  } catch (err) {
    console.error("CUSTOMER ME ERROR:", err);
    res.status(500).json({ error: "Could not load profile" });
  }
});

// PATCH /api/customer/profile  { name }
router.patch("/profile", verifyCustomerToken, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });

    await db.query(`UPDATE customers SET name=? WHERE id=?`, [name.trim(), req.customer.customerId]);
    res.json({ success: true, name: name.trim() });
  } catch (err) {
    console.error("CUSTOMER PROFILE UPDATE ERROR:", err);
    res.status(500).json({ error: "Could not update name" });
  }
});

// GET /api/customer/history
// Includes which machine (and where it's located) each job ran on, plus
// how it was paid — both useful for the customer's own record, and it's
// the same data admin sees on their side so support conversations line up.
router.get("/history", verifyCustomerToken, async (req, res) => {
  try {
    const [jobs] = await db.query(
      `SELECT
         pj.job_id, pj.file_name, pj.color, pj.copies, pj.paper_size, pj.print_side,
         pj.total_pages, pj.amount, pj.status, pj.payment_method,
         pj.created_at, pj.printed_at,
         pj.machine_id, m.name AS machine_name,
         l.name AS location_name, l.city
       FROM print_jobs pj
       LEFT JOIN machines m ON m.machine_id = pj.machine_id
       LEFT JOIN locations l ON l.id = m.location_id
       WHERE pj.customer_id=?
       ORDER BY pj.created_at DESC
       LIMIT 50`,
      [req.customer.customerId]
    );
    res.json({ jobs });
  } catch (err) {
    console.error("CUSTOMER HISTORY ERROR:", err);
    res.status(500).json({ error: "Could not load history" });
  }
});

module.exports = router;