const crypto = require("crypto");
const bcrypt  = require("bcrypt");
const db      = require("../database/db");
const razorpay = require("../config/razorpay"); // shared client (null if keys missing)
const env     = require("../config/env");

const SERVER_API_BASE = env.API_BASE_URL;

/* ===========================
   DASHBOARD STATS
=========================== */
exports.getStats = async (req, res) => {

  try {
    const [[jobsToday]] = await db.query(`
      SELECT COUNT(*) as total
      FROM print_jobs
      WHERE DATE(created_at)=CURDATE()
    `);

    const [[revenueToday]] = await db.query(`
      SELECT SUM(amount) as total
      FROM print_jobs
      WHERE status='PRINTED'
      AND DATE(created_at)=CURDATE()
    `);

    const [[machinesOnline]] = await db.query(`
      SELECT COUNT(*) as total
      FROM machines
      WHERE last_seen_at > NOW() - INTERVAL 2 MINUTE
    `);

    const [[machinesTotal]] = await db.query(`
      SELECT COUNT(*) as total
      FROM machines
    `);

    res.json({
      jobsToday:      jobsToday.total      || 0,
      revenueToday:   revenueToday.total   || 0,
      machinesOnline: machinesOnline.total || 0,
      machinesTotal:  machinesTotal.total  || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard error" });
  }
};

/* ===========================
   CREATE MACHINE
=========================== */
exports.createMachine = async (req, res) => {
  try {
    console.log("CREATE MACHINE BODY:", req.body);

    const {
      name,
      location,
      locationName,
      address,
      city,
      state,
      pincode,
      latitude,
      longitude
    } = req.body;

    // Use old location field if locationName not sent
    const finalLocationName =
      locationName ||
      location ||
      `${name || "Machine"} Location`;

    const [rows] = await db.query(`
      SELECT machine_id
      FROM machines
      ORDER BY id DESC
      LIMIT 1
    `);

    let machineId = "MH1000";

    if (rows.length > 0) {
      const lastNumber = parseInt(
        rows[0].machine_id.replace("MH", ""),
        10
      );

      machineId =
        "MH" +
        String(lastNumber + 1).padStart(4, "0");
    }

    // Create location record
    const [locationResult] = await db.query(
      `
      INSERT INTO locations
      (
        name,
        address,
        city,
        state,
        pincode,
        latitude,
        longitude
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        finalLocationName,
        address || null,
        city || null,
        state || null,
        pincode || null,
        latitude || null,
        longitude || null
      ]
    );

    const locationId = locationResult.insertId;

    const apiKey = crypto.randomBytes(32).toString("hex");

    const hash = await bcrypt.hash(apiKey, 10);

    await db.query(
      `
      INSERT INTO machines
      (
        machine_id,
        name,
        location_id,
        status,
        assigned,
        api_key_hash
      )
      VALUES
      (
        ?, ?, ?, 'PENDING', FALSE, ?
      )
      `,
      [
        machineId,
        name || machineId,
        locationId,
        hash
      ]
    );

    res.json({
      success: true,
      message: "Machine created successfully",
      credentials: {
        MACHINE_ID: machineId,
        API_KEY: apiKey,
        API_BASE: SERVER_API_BASE
      }
    });

  } catch (err) {
    console.error("CREATE MACHINE ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

/* ===========================
   UPDATE MACHINE
=========================== */

exports.updateMachine = async (req, res) => {
  try {

    const { machineId } = req.params;

    const {
      name,
      locationName,
      address,
      city,
      state,
      pincode,
      latitude,
      longitude,
    } = req.body;

    const [[machine]] = await db.query(
      `
      SELECT location_id
      FROM machines
      WHERE machine_id = ?
      `,
      [machineId]
    );

    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found",
      });
    }

    await db.query(
      `
      UPDATE locations
      SET
        name = ?,
        address = ?,
        city = ?,
        state = ?,
        pincode = ?,
        latitude = ?,
        longitude = ?
      WHERE id = ?
      `,
      [
        locationName,
        address,
        city,
        state,
        pincode,
        latitude || null,
        longitude || null,
        machine.location_id,
      ]
    );

    await db.query(
      `
      UPDATE machines
      SET
        name = ?
      WHERE machine_id = ?
      `,
      [
        name,
        machineId,
      ]
    );

    res.json({
      success: true,
      message: "Machine updated successfully",
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: "Unable to update machine",
    });

  }
};

/* ===========================
   DELETE MACHINE
=========================== */

exports.deleteMachine = async (req, res) => {

  const connection = await db.getConnection();

  try {

    await connection.beginTransaction();

    const { machineId } = req.params;

    const [[machine]] = await connection.query(
      `
      SELECT location_id
      FROM machines
      WHERE machine_id=?
      `,
      [machineId]
    );

    if (!machine) {

      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Machine not found",
      });

    }

    const [[jobs]] = await connection.query(
      `
      SELECT COUNT(*) total
      FROM print_jobs
      WHERE machine_id=?
      `,
      [machineId]
    );

    if (jobs.total > 0) {

      await connection.rollback();

      return res.status(400).json({
        success: false,
        message:
          "Cannot delete machine because print jobs exist.",
      });

    }

    await connection.query(
      `
      DELETE FROM machines
      WHERE machine_id=?
      `,
      [machineId]
    );

    await connection.query(
      `
      DELETE FROM locations
      WHERE id=?
      `,
      [machine.location_id]
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Machine deleted successfully",
    });

  } catch (err) {

    await connection.rollback();

    console.error(err);

    res.status(500).json({
      success: false,
      message: "Delete failed",
    });

  } finally {

    connection.release();

  }
};
/* ===========================
   MACHINES LIST
=========================== */
exports.getMachines = async (req, res) => {
  try {
    const [machines] = await db.query(`
      SELECT machine_id, last_seen_at, is_print_locked
      FROM machines
    `);
    res.json(machines);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch machines" });
  }
};

/* ===========================
   ALERTS
=========================== */
exports.getAlerts = async (req, res) => {
  try {
    const [alerts] = await db.query(`
      SELECT *
      FROM machine_alerts
      WHERE is_resolved=FALSE
      ORDER BY created_at DESC
    `);
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
};

/* ===========================
   LIVE JOBS
=========================== */
exports.getLiveJobs = async (req, res) => {
  try {
    const [jobs] = await db.query(`
      SELECT job_id, machine_id, status, created_at
      FROM print_jobs
      WHERE status IN ('CREATED','PAYING','PAID','PRINTING')
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch live jobs" });
  }
};

/* ===========================
   REVENUE CHART
=========================== */
exports.getRevenue = async (req, res) => {
  try {
    const { period = "week" } = req.query;

    let condition = "";

    switch (period) {
      case "today":
        condition = "DATE(created_at)=CURDATE()";
        break;

      case "week":
        condition = "created_at >= CURDATE() - INTERVAL 6 DAY";
        break;

      case "month":
        condition = "created_at >= CURDATE() - INTERVAL 30 DAY";
        break;

      case "year":
        condition = "created_at >= CURDATE() - INTERVAL 12 MONTH";
        break;

      default:
        condition = "created_at >= CURDATE() - INTERVAL 6 DAY";
    }

    const [rows] = await db.query(`
      SELECT
        DATE(created_at) AS day,
        SUM(amount) AS revenue
      FROM print_jobs
      WHERE
        status='PRINTED'
        AND ${condition}
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `);

    res.json(rows);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"Revenue fetch failed"
    });

  }
};

/* ===========================
   MACHINE INFO
=========================== */
exports.getMachineInfo = async (req, res) => {
  try {
    const [machines] = await db.query(`
SELECT
    m.machine_id,
    m.name,
    m.status,
    m.is_print_locked,
    m.last_seen_at,

    l.name AS location_name,
    l.address,
    l.city,
    l.state,
    l.pincode,

    COUNT(p.id) AS total_jobs,
    COALESCE(SUM(p.amount),0) AS revenue

FROM machines m

LEFT JOIN locations l
ON m.location_id = l.id

LEFT JOIN print_jobs p
ON p.machine_id = m.machine_id
AND p.status='PRINTED'

GROUP BY m.id

ORDER BY m.created_at DESC
`);

    const now = Date.now();

    const result = machines.map((m) => {
      let isOnline = false;
      if (m.last_seen_at) {
        const diff = (now - new Date(m.last_seen_at).getTime()) / 1000;
        isOnline = diff < 120;
      }
      return { ...m, is_online: isOnline };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch machine info" });
  }
};

/* ===========================
   MACHINE REPORT
=========================== */
exports.machineReport = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { period }    = req.query;

    // Whitelist interval to prevent any SQL injection
    const intervalMap = { "1": "1 MONTH", "3": "3 MONTH", "6": "6 MONTH", "12": "1 YEAR" };
    const interval = intervalMap[period] || "1 MONTH";

    const [rows] = await db.query(`
      SELECT
        DATE(created_at) as date,
        SUM(amount) as revenue
      FROM print_jobs
      WHERE machine_id = ?
        AND status = 'PRINTED'
        AND created_at > NOW() - INTERVAL ${interval}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [machineId]);

    res.json(rows);
  } catch (err) {
    console.error("REPORT ERROR:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
};

/* ===========================
   CREATE VENDOR
   Admin sets an initial password directly (no self-signup for vendors).
=========================== */
exports.createVendor = async (req, res) => {
  try {
    const { fullName, email, phone, businessName, gstNumber, password } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email and password are required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    const [[existing]] = await db.query(`SELECT id FROM vendors WHERE email=?`, [cleanEmail]);
    if (existing) return res.status(409).json({ error: "A vendor with this email already exists" });

    const hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO vendors (full_name, email, phone, password_hash, business_name, gst_number, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [fullName.trim(), cleanEmail, phone || null, hash, businessName || null, gstNumber || null]
    );

    res.json({
      success: true,
      vendor: { id: result.insertId, fullName, email: cleanEmail, businessName: businessName || null },
    });
  } catch (err) {
    console.error("CREATE VENDOR ERROR:", err);
    res.status(500).json({ error: "Failed to create vendor" });
  }
};

/* ===========================
   LIST VENDORS — machine count + lifetime revenue per vendor
=========================== */
exports.getVendors = async (req, res) => {
  try {
    const [vendors] = await db.query(`
      SELECT
        v.id, v.full_name, v.email, v.phone, v.business_name, v.gst_number, v.status, v.created_at,
        COUNT(DISTINCT m.id) AS machine_count,
        COALESCE(SUM(CASE WHEN p.status='PRINTED' THEN p.amount ELSE 0 END), 0) AS total_revenue
      FROM vendors v
      LEFT JOIN machines m ON m.owner_vendor_id = v.id
      LEFT JOIN print_jobs p ON p.machine_id = m.machine_id
      GROUP BY v.id
      ORDER BY v.created_at DESC
    `);
    res.json(vendors);
  } catch (err) {
    console.error("GET VENDORS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch vendors" });
  }
};

/* ===========================
   VENDOR DETAIL — admin drill-down view of one vendor
=========================== */
exports.getVendorDetail = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const [[vendor]] = await db.query(
      `SELECT id, full_name, email, phone, business_name, gst_number, status, created_at
       FROM vendors WHERE id=?`,
      [vendorId]
    );
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const [machines] = await db.query(`
      SELECT m.machine_id, m.name, m.status, m.last_seen_at,
        COUNT(p.id) AS total_prints,
        COALESCE(SUM(CASE WHEN p.status='PRINTED' THEN p.amount ELSE 0 END), 0) AS revenue
      FROM machines m
      LEFT JOIN print_jobs p ON p.machine_id = m.machine_id AND p.status='PRINTED'
      WHERE m.owner_vendor_id = ?
      GROUP BY m.id
    `, [vendorId]);

    const [[bank]] = await db.query(
      `SELECT * FROM bank_accounts WHERE vendor_id=? ORDER BY id DESC LIMIT 1`, [vendorId]
    );

    res.json({ vendor, machines, bank: bank || null });
  } catch (err) {
    console.error("GET VENDOR DETAIL ERROR:", err);
    res.status(500).json({ error: "Failed to fetch vendor detail" });
  }
};

/* ===========================
   LIST CUSTOMERS
   Includes a quick "needs attention" signal per customer so the admin
   can scan the list without opening every profile:
   - problem_jobs: paid-but-never-verified (EXPIRED) or explicitly FAILED
   - stuck_jobs: OTP verified (PRINTING) but no print/fail confirmation
     in 15+ minutes — usually means the machine hung or jammed.
=========================== */
exports.getCustomers = async (req, res) => {
  try {
    const [customers] = await db.query(`
      SELECT c.id, c.name, c.phone, c.created_at,
        COUNT(p.id) AS total_orders,
        COALESCE(SUM(CASE WHEN p.status='PRINTED' THEN p.amount ELSE 0 END), 0) AS total_spent,
        SUM(CASE WHEN p.status IN ('EXPIRED','FAILED') THEN 1 ELSE 0 END) AS problem_jobs,
        SUM(CASE WHEN p.status='PRINTING' AND p.updated_at < NOW() - INTERVAL 15 MINUTE THEN 1 ELSE 0 END) AS stuck_jobs
      FROM customers c
      LEFT JOIN print_jobs p ON p.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json(customers);
  } catch (err) {
    console.error("GET CUSTOMERS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
};

/* ===========================
   CUSTOMER DETAIL — full print job history across every machine
   they've used, with a computed `flag` per job so the admin can spot
   refund/investigation candidates at a glance:
     - PAID_NOT_VERIFIED : payment succeeded but OTP was never entered
                            before it expired (cron already marks these
                            EXPIRED — see the cleanup job in server.js)
     - STUCK_PRINTING     : OTP was verified (job moved to PRINTING) but
                            there's been no PRINTED/FAILED confirmation
                            in 15+ minutes — likely a machine/paper issue
     - FAILED             : explicitly marked failed (refund attempted
                             automatically if a payment_id existed)
=========================== */
exports.getCustomerDetail = async (req, res) => {
  try {
    const { customerId } = req.params;

    const [[customer]] = await db.query(
      `SELECT id, name, phone, created_at FROM customers WHERE id=?`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const [jobs] = await db.query(`
      SELECT
        pj.job_id, pj.machine_id, m.name AS machine_name,
        pj.file_name, pj.total_pages, pj.copies, pj.color, pj.paper_size, pj.print_side,
        pj.amount, pj.status, pj.payment_id, pj.payment_method, pj.payment_details,
        pj.created_at, pj.updated_at, pj.printed_at,
        pjt.otp_verified, pjt.otp_expires_at
      FROM print_jobs pj
      LEFT JOIN machines m ON m.machine_id = pj.machine_id
      LEFT JOIN print_job_tokens pjt ON pjt.job_id = pj.job_id
      WHERE pj.customer_id = ?
      ORDER BY pj.created_at DESC
    `, [customerId]);

    const now = Date.now();
    const enrichedJobs = jobs.map((j) => {
      let flag = null;
      if (j.status === "EXPIRED") {
        flag = "PAID_NOT_VERIFIED";
      } else if (j.status === "PRINTING") {
        const sinceUpdate = j.updated_at ? now - new Date(j.updated_at).getTime() : null;
        if (sinceUpdate !== null && sinceUpdate > 15 * 60 * 1000) {
          flag = "STUCK_PRINTING";
        }
      } else if (j.status === "FAILED") {
        flag = "FAILED";
      }

      let paymentDetails = j.payment_details;
      if (typeof paymentDetails === "string") {
        try { paymentDetails = JSON.parse(paymentDetails); } catch { paymentDetails = null; }
      }

      return { ...j, payment_details: paymentDetails, flag };
    });

    res.json({ customer, jobs: enrichedJobs });
  } catch (err) {
    console.error("GET CUSTOMER DETAIL ERROR:", err);
    res.status(500).json({ error: "Failed to fetch customer detail" });
  }
};

/* ===========================
   ASSIGN / UNASSIGN MACHINE
=========================== */
exports.assignMachineToVendor = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { vendorId } = req.body;
    if (!vendorId) return res.status(400).json({ error: "vendorId is required" });

    const [[vendor]] = await db.query(`SELECT id FROM vendors WHERE id=?`, [vendorId]);
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const [r] = await db.query(`UPDATE machines SET owner_vendor_id=? WHERE machine_id=?`, [vendorId, machineId]);
    if (!r.affectedRows) return res.status(404).json({ error: "Machine not found" });

    res.json({ success: true });
  } catch (err) {
    console.error("ASSIGN MACHINE ERROR:", err);
    res.status(500).json({ error: "Failed to assign machine" });
  }
};

exports.unassignMachine = async (req, res) => {
  try {
    const { machineId } = req.params;
    const [r] = await db.query(`UPDATE machines SET owner_vendor_id=NULL WHERE machine_id=?`, [machineId]);
    if (!r.affectedRows) return res.status(404).json({ error: "Machine not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("UNASSIGN MACHINE ERROR:", err);
    res.status(500).json({ error: "Failed to unassign machine" });
  }
};

/* ===========================
   WITHDRAWALS — list + approve/reject/mark-paid
=========================== */
exports.getWithdrawals = async (req, res) => {
  try {
    const { status } = req.query; // optional filter: PENDING | APPROVED | REJECTED | PAID
    const params = [];
    let where = "";
    if (status) { where = "WHERE w.status=?"; params.push(status); }

    const [rows] = await db.query(`
      SELECT w.*, v.full_name AS vendor_name, v.email AS vendor_email
      FROM withdrawals w
      JOIN vendors v ON v.id = w.vendor_id
      ${where}
      ORDER BY w.requested_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error("GET WITHDRAWALS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
};

exports.updateWithdrawalStatus = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { withdrawalId } = req.params;
    const { status, remarks } = req.body; // APPROVED | REJECTED | PAID

    if (!["APPROVED", "REJECTED", "PAID"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    await connection.beginTransaction();

    const [[withdrawal]] = await connection.query(
      `SELECT * FROM withdrawals WHERE id=? FOR UPDATE`, [withdrawalId]
    );
    if (!withdrawal) {
      await connection.rollback();
      return res.status(404).json({ error: "Withdrawal not found" });
    }

    await connection.query(
      `UPDATE withdrawals
       SET status=?, remarks=?, approved_at=IF(?='APPROVED', NOW(), approved_at), approved_by=?
       WHERE id=?`,
      [status, remarks || null, status, req.staff.id, withdrawalId]
    );

    // Mark-paid also writes the payout ledger row.
    if (status === "PAID") {
      await connection.query(
        `INSERT INTO payouts (withdrawal_id, amount, status, paid_at) VALUES (?, ?, 'SUCCESS', NOW())`,
        [withdrawalId, withdrawal.amount]
      );
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error("UPDATE WITHDRAWAL ERROR:", err);
    res.status(500).json({ error: "Failed to update withdrawal" });
  } finally {
    connection.release();
  }
};

/* ===========================
   REVENUE OVERVIEW — platform totals + per-vendor breakdown
   (Per-machine breakdown is already covered by your existing getMachineInfo.)
=========================== */
exports.getRevenueOverview = async (req, res) => {
  try {
    const [[totals]] = await db.query(`
      SELECT COALESCE(SUM(amount),0) AS total_revenue, COUNT(*) AS total_prints
      FROM print_jobs WHERE status='PRINTED'
    `);

    const [perVendor] = await db.query(`
      SELECT v.id AS vendor_id, v.full_name AS vendor_name,
        COALESCE(SUM(p.amount),0) AS revenue,
        COUNT(p.id) AS prints
      FROM vendors v
      LEFT JOIN machines m ON m.owner_vendor_id=v.id
      LEFT JOIN print_jobs p ON p.machine_id=m.machine_id AND p.status='PRINTED'
      GROUP BY v.id
      ORDER BY revenue DESC
    `);

    res.json({ totals, perVendor });
  } catch (err) {
    console.error("REVENUE OVERVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to fetch revenue overview" });
  }
};

/* ===========================
   MACHINE JOBS — reverse view of customer detail: which customers
   have used THIS machine, with the same PAID_NOT_VERIFIED /
   STUCK_PRINTING / FAILED flags so problem jobs are visible either
   way you're looking at the data (by customer or by machine).
=========================== */
exports.getMachineJobs = async (req, res) => {
  try {
    const { machineId } = req.params;

    const [[machine]] = await db.query(
      `SELECT machine_id, name FROM machines WHERE machine_id=?`,
      [machineId]
    );
    if (!machine) return res.status(404).json({ error: "Machine not found" });

    const [jobs] = await db.query(`
      SELECT
        pj.job_id, pj.customer_id, c.name AS customer_name, c.phone AS customer_phone,
        pj.file_name, pj.amount, pj.status, pj.payment_id, pj.payment_method, pj.payment_details,
        pj.created_at, pj.updated_at, pj.printed_at
      FROM print_jobs pj
      LEFT JOIN customers c ON c.id = pj.customer_id
      WHERE pj.machine_id = ?
      ORDER BY pj.created_at DESC
    `, [machineId]);

    const now = Date.now();
    const enrichedJobs = jobs.map((j) => {
      let flag = null;
      if (j.status === "EXPIRED") {
        flag = "PAID_NOT_VERIFIED";
      } else if (j.status === "PRINTING") {
        const sinceUpdate = j.updated_at ? now - new Date(j.updated_at).getTime() : null;
        if (sinceUpdate !== null && sinceUpdate > 15 * 60 * 1000) {
          flag = "STUCK_PRINTING";
        }
      } else if (j.status === "FAILED") {
        flag = "FAILED";
      }

      let paymentDetails = j.payment_details;
      if (typeof paymentDetails === "string") {
        try { paymentDetails = JSON.parse(paymentDetails); } catch { paymentDetails = null; }
      }

      return { ...j, payment_details: paymentDetails, flag };
    });

    res.json({ machine, jobs: enrichedJobs });
  } catch (err) {
    console.error("GET MACHINE JOBS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch machine jobs" });
  }
};

/* ===========================
   MANUAL REFUND — for jobs that never went through the automatic
   mark-failed→refund flow (e.g. paid but OTP expired unused, or a
   machine that hung mid-print and never called mark-failed). Refunds
   go back to whatever payment method was originally used — Razorpay
   handles that routing automatically, we just call the API.
=========================== */
exports.refundJob = async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Payment service unavailable" });

    const { jobId } = req.params;

    const [[job]] = await db.query(`SELECT * FROM print_jobs WHERE job_id=?`, [jobId]);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!job.payment_id) {
      return res.status(400).json({ error: "No payment was captured for this job — nothing to refund" });
    }
    if (!["PAID", "PRINTING", "EXPIRED", "FAILED"].includes(job.status)) {
      return res.status(400).json({ error: `Refunding a job in status ${job.status} isn't supported` });
    }

    const refund = await razorpay.payments.refund(job.payment_id, {
      amount: Math.round(Number(job.amount) * 100),
    });

    // Move it to FAILED so it drops out of the "needs attention" flags,
    // and log the refund reference for reconciliation.
    await db.query(
      `UPDATE print_jobs SET status='FAILED', updated_at=NOW() WHERE id=?`,
      [job.id]
    );

    await db.query(
      `INSERT INTO audit_logs (machine_id, job_id, action_type, actor_admin_id, details)
       VALUES (?, ?, 'JOB_FAILED', ?, ?)`,
      [job.machine_id, job.job_id, req.staff.id, JSON.stringify({ manual_refund: true, refund_id: refund.id })]
    );

    res.json({ success: true, refundId: refund.id });
  } catch (err) {
    console.error("REFUND JOB ERROR:", err);
    res.status(500).json({ error: err.message || "Refund failed" });
  }
};