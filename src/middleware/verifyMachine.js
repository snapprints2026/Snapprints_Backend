// src/middleware/verifyMachine.js
// Authenticates Raspberry Pi kiosks. Every kiosk request carries:
//   x-machine-id, x-timestamp, x-api-key, x-signature
// where signature = HMAC-SHA256(apiKey, machineId + timestamp + JSON(body)).
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const db = require("../database/db");

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function checkMachineCredentials({ machineId, timestamp, signature, apiKey, body }) {
  if (!machineId || !timestamp || !signature || !apiKey)
    return { status: 401, error: "Missing auth headers" };

  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000)
    return { status: 401, error: "Request expired" };

  const [[machine]] = await db.query(
    `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`, [machineId]
  );
  if (!machine) return { status: 403, error: "Invalid machine" };

  const valid = await bcrypt.compare(apiKey, machine.api_key_hash);
  if (!valid) return { status: 403, error: "Key mismatch" };

  const expected = crypto
    .createHmac("sha256", apiKey)
    .update(machineId + timestamp + JSON.stringify(body || {}))
    .digest("hex");
  if (!safeEqualHex(expected, signature)) return { status: 403, error: "Invalid signature" };

  return { machine };
}

async function verifyMachine(req, res, next) {
  try {
    const result = await checkMachineCredentials({
      machineId: req.headers["x-machine-id"],
      timestamp: req.headers["x-timestamp"],
      signature: req.headers["x-signature"],
      apiKey: req.headers["x-api-key"],
      body: req.body,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    req.machine = result.machine;
    next();
  } catch (err) {
    console.error("MACHINE AUTH ERROR:", err);
    res.status(500).json({ error: "Auth failed" });
  }
}

module.exports = { verifyMachine, checkMachineCredentials };
