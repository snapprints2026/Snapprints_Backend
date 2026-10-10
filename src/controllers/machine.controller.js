// src/controllers/machine.controller.js
const db = require("../database/db");

/* GET /api/machines/:machineId/status — public, used by the upload page after QR scan */
exports.getStatus = async (req, res) => {
  const { machineId } = req.params;

  let machine = null;
  try {
    const [rows] = await db.query(`SELECT * FROM machines WHERE machine_id=?`, [machineId]);
    machine = rows.length ? rows[0] : null;
  } catch (err) {
    console.error("STATUS machines query error:", err.message);
    return res.status(500).json({ error: "DB error" });
  }
  if (!machine) return res.status(404).json({ error: "Machine not found" });

  let isOnline = false, paperLevel = null;
  try {
    const [hb] = await db.query(
      `SELECT paper_level, created_at FROM machine_heartbeat_logs
       WHERE machine_id=? ORDER BY created_at DESC LIMIT 1`,
      [machineId]
    );
    if (hb.length) {
      const diff = (Date.now() - new Date(hb[0].created_at).getTime()) / 1000;
      isOnline = diff < 120;
      paperLevel = hb[0].paper_level ?? null;
    }
  } catch (err) {
    console.warn("STATUS heartbeat query warn:", err.message);
  }

  return res.json({
    machine_id: machine.machine_id,
    is_online: isOnline,
    paper_level: paperLevel,
    is_print_locked: machine.is_print_locked,
  });
};
