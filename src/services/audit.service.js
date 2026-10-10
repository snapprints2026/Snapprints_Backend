// src/services/audit.service.js
// audit_logs.action_type is a fixed MySQL enum. Labels outside it are stored
// as 'OTHER' (JOB_UNLOCKED → 'JOB_PRINTING'), with the original label kept
// in `details` so nothing is lost. Never throws.
const db = require("../database/db");

const AUDIT_ACTION_TYPES = new Set([
  "MACHINE_CREATED", "MACHINE_UPDATED", "MACHINE_DISABLED", "MACHINE_API_KEY_ROTATED",
  "JOB_CREATED", "JOB_PRICED", "JOB_PAID", "JOB_PRINTING", "JOB_PRINTED", "JOB_FAILED", "JOB_EXPIRED",
  "ALERT_CREATED", "ALERT_RESOLVED", "PRICING_RULE_CREATED", "PRICING_RULE_UPDATED",
  "ADMIN_LOGIN", "ADMIN_LOGOUT", "OTHER",
]);

async function logAudit(machineId, jobId, action, details = null) {
  try {
    const actionType = AUDIT_ACTION_TYPES.has(action)
      ? action
      : (action === "JOB_UNLOCKED" ? "JOB_PRINTING" : "OTHER");

    const mergedDetails = actionType === action ? details : { event: action, ...(details || {}) };

    await db.query(
      `INSERT INTO audit_logs (machine_id, job_id, action_type, details) VALUES (?, ?, ?, ?)`,
      [machineId, jobId, actionType, JSON.stringify(mergedDetails)]
    );
  } catch (err) {
    console.error("AUDIT LOG ERROR:", err.message);
  }
}

module.exports = { logAudit };
