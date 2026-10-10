// controllers/vendor.controller.js
const db = require("../database/db");

/* Whitelisted date-range conditions — never build these from raw user input. */
function periodCondition(range) {
  switch (range) {
    case "day":    return "p.created_at >= CURDATE()";
    case "week":   return "p.created_at >= CURDATE() - INTERVAL 6 DAY";
    case "month":  return "p.created_at >= CURDATE() - INTERVAL 30 DAY";
    case "6month": return "p.created_at >= CURDATE() - INTERVAL 6 MONTH";
    case "year":   return "p.created_at >= CURDATE() - INTERVAL 12 MONTH";
    default:       return "p.created_at >= CURDATE() - INTERVAL 6 DAY";
  }
}

/* ===========================
   GET /api/vendor/me
=========================== */
exports.getMe = async (req, res) => {
  try {
    const [[vendor]] = await db.query(
      `SELECT id, full_name, email, phone, business_name, gst_number, status, created_at
       FROM vendors WHERE id=?`,
      [req.staff.id]
    );
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    res.json(vendor);
  } catch (err) {
    console.error("VENDOR ME ERROR:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
};

/* ===========================
   GET /api/vendor/machines
   List of owned machines with online status, print counts, revenue.
=========================== */
exports.getMyMachines = async (req, res) => {
  try {
    const [machines] = await db.query(`
      SELECT
        m.machine_id, m.name, m.status, m.is_print_locked, m.last_seen_at,
        l.name AS location_name, l.city, l.state,
        COUNT(p.id) AS total_jobs,
        SUM(CASE WHEN p.status='PRINTED' THEN 1 ELSE 0 END) AS total_prints,
        COALESCE(SUM(CASE WHEN p.status='PRINTED' THEN p.amount ELSE 0 END), 0) AS total_revenue
      FROM machines m
      LEFT JOIN locations l ON l.id = m.location_id
      LEFT JOIN print_jobs p ON p.machine_id = m.machine_id
      WHERE m.owner_vendor_id = ?
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `, [req.staff.id]);

    const now = Date.now();
    const result = machines.map((m) => {
      let isOnline = false;
      if (m.last_seen_at) isOnline = (now - new Date(m.last_seen_at).getTime()) / 1000 < 120;
      return { ...m, is_online: isOnline };
    });

    res.json(result);
  } catch (err) {
    console.error("VENDOR MACHINES ERROR:", err);
    res.status(500).json({ error: "Failed to fetch machines" });
  }
};

/* ===========================
   GET /api/vendor/machines/:machineId/revenue?range=day|week|month|6month|year
   Daily-bucketed revenue for ONE owned machine.
=========================== */
exports.getMachineRevenue = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { range } = req.query;

    // Ownership check — a vendor must never see another vendor's machine data.
    const [[owned]] = await db.query(
      `SELECT id FROM machines WHERE machine_id=? AND owner_vendor_id=?`,
      [machineId, req.staff.id]
    );
    if (!owned) return res.status(403).json({ error: "You do not own this machine" });

    const [rows] = await db.query(`
      SELECT DATE(p.created_at) AS date, SUM(p.amount) AS revenue, COUNT(*) AS prints
      FROM print_jobs p
      WHERE p.machine_id=? AND p.status='PRINTED' AND ${periodCondition(range)}
      GROUP BY DATE(p.created_at)
      ORDER BY date ASC
    `, [machineId]);

    res.json(rows);
  } catch (err) {
    console.error("MACHINE REVENUE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch machine revenue" });
  }
};

/* ===========================
   GET /api/vendor/revenue-summary?range=...
   Daily-bucketed revenue ACROSS all owned machines, plus all-time totals.
=========================== */
exports.getRevenueSummary = async (req, res) => {
  try {
    const { range } = req.query;

    const [series] = await db.query(`
      SELECT DATE(p.created_at) AS date, SUM(p.amount) AS revenue, COUNT(*) AS prints
      FROM print_jobs p
      JOIN machines m ON m.machine_id = p.machine_id
      WHERE m.owner_vendor_id=? AND p.status='PRINTED' AND ${periodCondition(range)}
      GROUP BY DATE(p.created_at)
      ORDER BY date ASC
    `, [req.staff.id]);

    const [[totals]] = await db.query(`
      SELECT COALESCE(SUM(p.amount),0) AS total_revenue, COUNT(*) AS total_prints
      FROM print_jobs p
      JOIN machines m ON m.machine_id = p.machine_id
      WHERE m.owner_vendor_id=? AND p.status='PRINTED'
    `, [req.staff.id]);

    res.json({ series, totals });
  } catch (err) {
    console.error("VENDOR REVENUE SUMMARY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch revenue summary" });
  }
};

/* ===========================
   POST /api/vendor/bank-account
   Upsert — one bank account per vendor (matches bank_accounts schema).
=========================== */
exports.upsertBankAccount = async (req, res) => {
  try {
    const { bankName, accountHolder, accountNumber, ifsc, branchName, accountType } = req.body;

    if (!bankName || !accountHolder || !accountNumber || !ifsc || !accountType) {
      return res.status(400).json({ error: "Missing required bank fields" });
    }
    if (!["SAVINGS", "CURRENT"].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be SAVINGS or CURRENT" });
    }

    const [[existing]] = await db.query(`SELECT id FROM bank_accounts WHERE vendor_id=?`, [req.staff.id]);

    if (existing) {
      await db.query(
        `UPDATE bank_accounts
         SET bank_name=?, account_holder=?, account_number=?, ifsc=?, branch_name=?, account_type=?, verified=0
         WHERE id=?`,
        [bankName, accountHolder, accountNumber, ifsc, branchName || null, accountType, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO bank_accounts
         (vendor_id, bank_name, account_holder, account_number, ifsc, branch_name, account_type, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [req.staff.id, bankName, accountHolder, accountNumber, ifsc, branchName || null, accountType]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("BANK ACCOUNT UPSERT ERROR:", err);
    res.status(500).json({ error: "Failed to save bank account" });
  }
};

/* ===========================
   GET /api/vendor/bank-account
=========================== */
exports.getBankAccount = async (req, res) => {
  try {
    const [[bank]] = await db.query(
      `SELECT * FROM bank_accounts WHERE vendor_id=? ORDER BY id DESC LIMIT 1`,
      [req.staff.id]
    );
    res.json(bank || null);
  } catch (err) {
    console.error("GET BANK ACCOUNT ERROR:", err);
    res.status(500).json({ error: "Failed to fetch bank account" });
  }
};

/* ===========================
   GET /api/vendor/balance
   Available = lifetime PRINTED revenue - (PENDING+APPROVED+PAID withdrawals)
=========================== */
async function computeBalance(vendorId) {
  const [[totalsRow]] = await db.query(`
    SELECT COALESCE(SUM(p.amount),0) AS total_revenue
    FROM print_jobs p JOIN machines m ON m.machine_id=p.machine_id
    WHERE m.owner_vendor_id=? AND p.status='PRINTED'
  `, [vendorId]);

  const [[withdrawnRow]] = await db.query(`
    SELECT COALESCE(SUM(amount),0) AS total_withdrawn
    FROM withdrawals WHERE vendor_id=? AND status IN ('PENDING','APPROVED','PAID')
  `, [vendorId]);

  const totalRevenue   = Number(totalsRow.total_revenue);
  const totalWithdrawn = Number(withdrawnRow.total_withdrawn);
  return { totalRevenue, totalWithdrawn, available: totalRevenue - totalWithdrawn };
}

exports.getAvailableBalance = async (req, res) => {
  try {
    res.json(await computeBalance(req.staff.id));
  } catch (err) {
    console.error("AVAILABLE BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to compute balance" });
  }
};

/* ===========================
   POST /api/vendor/withdrawals   body: { amount }
=========================== */
exports.requestWithdrawal = async (req, res) => {
  try {
    const amt = Number(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: "Enter a valid amount" });

    const [[bank]] = await db.query(`SELECT id FROM bank_accounts WHERE vendor_id=?`, [req.staff.id]);
    if (!bank) return res.status(400).json({ error: "Add your bank details before requesting a withdrawal" });

    const { available } = await computeBalance(req.staff.id);
    if (amt > available) {
      return res.status(400).json({ error: `Requested amount exceeds available balance (₹${available.toFixed(2)})` });
    }

    const [result] = await db.query(
      `INSERT INTO withdrawals (vendor_id, amount, status) VALUES (?, ?, 'PENDING')`,
      [req.staff.id, amt]
    );

    res.json({ success: true, withdrawalId: result.insertId });
  } catch (err) {
    console.error("REQUEST WITHDRAWAL ERROR:", err);
    res.status(500).json({ error: "Failed to submit withdrawal request" });
  }
};

/* ===========================
   GET /api/vendor/withdrawals
=========================== */
exports.getMyWithdrawals = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM withdrawals WHERE vendor_id=? ORDER BY requested_at DESC`,
      [req.staff.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET MY WITHDRAWALS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
};