const crypto = require("crypto");
const bcrypt  = require("bcrypt");
const db      = require("../database/db");
const razorpay = require("../config/razorpay"); // shared client (null if keys missing)
const env     = require("../config/env");

const SERVER_API_BASE = env.API_BASE_URL;

/* ===========================
   SHARED HELPERS — input cleaning / validation for machines & vendors
=========================== */
const MODULES = ["KIOSK", "SHOP"];
const WEEK_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const INSTITUTION_TYPES = ["COLLEGE", "UNIVERSITY", "SCHOOL", "COACHING", "SHOP", "OTHER"];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  return e;
}

// Trim; empty string → NULL; optionally cut to the column length.
function clean(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function parsePincode(v) {
  const s = clean(v);
  if (!s) return null;
  if (!/^\d{6}$/.test(s)) throw badRequest("Pincode must be 6 digits");
  return s;
}

function parsePhone(v, label) {
  const s = clean(v);
  if (!s) return null;
  const compact = s.replace(/[\s-]/g, "");
  if (!/^\+?\d{10,13}$/.test(compact)) throw badRequest(`Invalid ${label}`);
  return compact;
}

function parseCoord(v, min, max, label) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`Invalid ${label}`);
  return n;
}

// "9:00", "09:00" or "09:00:00" → "09:00:00"
function parseTime(v) {
  const s = clean(v);
  if (!s) return null;
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!m) throw badRequest(`Invalid time "${s}" — use HH:MM`);
  return `${m[1].padStart(2, "0")}:${m[2]}:00`;
}

// ["SUN"] / "sat,sun" / "Sunday" → "SAT,SUN" (always in week order)
function parseWeeklyOff(v) {
  if (v === undefined || v === null || v === "") return null;
  const list = (Array.isArray(v) ? v : String(v).split(","))
    .map((d) => String(d).trim().toUpperCase().slice(0, 3))
    .filter(Boolean);
  const bad = list.find((d) => !WEEK_DAYS.includes(d));
  if (bad) throw badRequest(`Invalid weekly off day "${bad}"`);
  const ordered = WEEK_DAYS.filter((d) => list.includes(d));
  return ordered.length ? ordered.join(",") : null;
}

function parseDate(v) {
  const s = clean(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw badRequest("Installation date must be YYYY-MM-DD");
  }
  return s;
}

function parseModule(v) {
  const m = String(v || "KIOSK").trim().toUpperCase();
  if (!MODULES.includes(m)) throw badRequest("module must be KIOSK or SHOP");
  return m;
}

function vendorModules(vendor) {
  return String((vendor && vendor.allowed_modules) || "KIOSK")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function assertVendorHasModule(vendor, module) {
  const allowed = vendorModules(vendor);
  if (!allowed.includes(module)) {
    throw badRequest(
      `This vendor has not bought the ${module} module (allowed: ${allowed.join(", ")})`
    );
  }
}

// request-body key → [locations column, parser]
const LOCATION_INPUTS = {
  locationName: ["name",          (v) => clean(v, 200)],
  campusName:   ["campus_name",   (v) => clean(v, 150)],
  building:     ["building",      (v) => clean(v, 100)],
  floor:        ["floor",         (v) => clean(v, 50)],
  spot:         ["spot",          (v) => clean(v, 150)],
  landmark:     ["landmark",      (v) => clean(v, 200)],
  address:      ["address",       (v) => clean(v, 500)],
  city:         ["city",          (v) => clean(v, 100)],
  state:        ["state",         (v) => clean(v, 100)],
  pincode:      ["pincode",       parsePincode],
  latitude:     ["latitude",      (v) => parseCoord(v, -90, 90, "latitude")],
  longitude:    ["longitude",     (v) => parseCoord(v, -180, 180, "longitude")],
  contactName:  ["contact_name",  (v) => clean(v, 120)],
  contactPhone: ["contact_phone", (v) => parsePhone(v, "on-site contact phone")],
  openTime:     ["open_time",     parseTime],
  closeTime:    ["close_time",    parseTime],
  weeklyOff:    ["weekly_off",    parseWeeklyOff],
};

// request-body key → [machines column, parser]
const MACHINE_INPUTS = {
  printerModel: ["printer_model", (v) => clean(v, 100)],
  installedAt:  ["installed_at",  parseDate],
};

// onlyPresent = true → only fields the client actually sent (for partial updates)
function readFields(body, spec, { onlyPresent }) {
  const out = {};
  for (const [key, [column, parse]] of Object.entries(spec)) {
    if (onlyPresent && !has(body, key)) continue;
    out[column] = parse(body[key]);
  }
  return out;
}

// "ABC College · Main Campus · Block B, Ground floor · Library entrance"
function buildLocationLabel(r) {
  const where = [r.building, r.floor].filter(Boolean).join(", ");
  let inside = [r.campus_name, where, r.spot].filter(Boolean);
  if (!inside.length && r.location_name) inside = [r.location_name];
  const parts = [r.vendor_name, ...inside].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// Columns every machine list / detail needs to show WHERE a machine is.
// Expects aliases: m = machines, l = locations, v = vendors.
const MACHINE_LOCATION_COLUMNS = `
  m.machine_id, m.name, m.module, m.status, m.is_print_locked, m.last_seen_at,
  m.owner_vendor_id, m.printer_model,
  DATE_FORMAT(m.installed_at, '%Y-%m-%d') AS installed_at,
  COALESCE(v.business_name, v.full_name) AS vendor_name,
  l.name AS location_name, l.campus_name, l.building, l.floor, l.spot, l.landmark,
  l.address, l.city, l.state, l.pincode, l.latitude, l.longitude,
  l.contact_name, l.contact_phone,
  TIME_FORMAT(l.open_time,  '%H:%i') AS open_time,
  TIME_FORMAT(l.close_time, '%H:%i') AS close_time,
  l.weekly_off
`;

const PRINTED_STATS_JOIN = `
  LEFT JOIN (
    SELECT machine_id, COUNT(*) AS total_jobs, SUM(amount) AS revenue
    FROM print_jobs
    WHERE status='PRINTED'
    GROUP BY machine_id
  ) ps ON ps.machine_id = m.machine_id
`;

// Machine IDs: SP (SnapPrints) + K (kiosk) / S (shop computer) + number.
//   Kiosks:         SPK1001, SPK1002, …
//   Shop computers: SPS1001, SPS1002, …
// Each type counts on its own. Old MH… machines keep their IDs and are
// simply ignored by this counter.
const MACHINE_ID_PREFIX = { KIOSK: "SPK", SHOP: "SPS" };
const MACHINE_ID_START  = 1001;

async function nextMachineId(conn, module) {
  const prefix = MACHINE_ID_PREFIX[module] || MACHINE_ID_PREFIX.KIOSK;
  const [[row]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(machine_id, ?) AS UNSIGNED)) AS n
     FROM machines
     WHERE machine_id REGEXP ?`,
    [prefix.length + 1, `^${prefix}[0-9]+$`]
  );
  const n = row && row.n ? Number(row.n) + 1 : MACHINE_ID_START;
  return prefix + String(n).padStart(4, "0");
}

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
   Body (all optional except where noted):
     vendorId, module ('KIOSK' | 'SHOP'), name,
     campusName, building, floor, spot, landmark, locationName,
     address, city, state, pincode, latitude, longitude,
     contactName, contactPhone, openTime, closeTime, weeklyOff,
     printerModel, installedAt
   The location + machine rows are written in one transaction, and the
   machine ID is retried if two admins create a machine at the same time.
=========================== */
exports.createMachine = async (req, res) => {
  try {
    const body = { ...(req.body || {}) };

    // Old clients send `location` instead of `locationName`
    if (!body.locationName && body.location) body.locationName = body.location;

    const locationFields = readFields(body, LOCATION_INPUTS, { onlyPresent: false });
    const machineFields  = readFields(body, MACHINE_INPUTS,  { onlyPresent: false });
    const module = parseModule(body.module);
    const name   = clean(body.name, 150);

    let vendor = null;
    if (body.vendorId) {
      const [[v]] = await db.query(
        `SELECT id, full_name, business_name, allowed_modules, status FROM vendors WHERE id=?`,
        [body.vendorId]
      );
      if (!v) throw notFound("Vendor not found");
      if (v.status !== "ACTIVE") throw badRequest("This vendor is not active");
      assertVendorHasModule(v, module);
      vendor = v;
    }

    if (!locationFields.name) {
      const where = [locationFields.spot, locationFields.building].filter(Boolean).join(", ");
      locationFields.name = clean(where, 200) || `${name || "Machine"} Location`;
    }

    const apiKey = crypto.randomBytes(32).toString("hex");
    const hash   = await bcrypt.hash(apiKey, 10);

    for (let attempt = 1; ; attempt++) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // Column names come from LOCATION_INPUTS (fixed list), never from the client.
        const cols = Object.keys(locationFields);
        const [locationResult] = await conn.query(
          `INSERT INTO locations (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          cols.map((c) => locationFields[c])
        );

        const machineId = await nextMachineId(conn, module);

        await conn.query(
          `
          INSERT INTO machines
            (machine_id, name, module, location_id, owner_vendor_id,
             status, assigned, api_key_hash, printer_model, installed_at)
          VALUES (?, ?, ?, ?, ?, 'PENDING', FALSE, ?, ?, ?)
          `,
          [
            machineId,
            name || machineId,
            module,
            locationResult.insertId,
            vendor ? vendor.id : null,
            hash,
            machineFields.printer_model,
            machineFields.installed_at,
          ]
        );

        await conn.query(
          `INSERT INTO audit_logs (machine_id, action_type, actor_admin_id, details)
           VALUES (?, 'MACHINE_CREATED', ?, ?)`,
          [
            machineId,
            req.staff ? req.staff.id : null,
            JSON.stringify({ module, vendor_id: vendor ? vendor.id : null }),
          ]
        );

        await conn.commit();

        return res.json({
          success: true,
          message: "Machine created successfully",
          machine: {
            machine_id: machineId,
            module,
            location_label: buildLocationLabel({
              ...locationFields,
              location_name: locationFields.name,
              vendor_name: vendor ? vendor.business_name || vendor.full_name : null,
            }),
          },
          credentials: {
            MACHINE_ID: machineId,
            API_KEY: apiKey,
            API_BASE: SERVER_API_BASE,
          },
        });
      } catch (err) {
        await conn.rollback().catch(() => {});
        const idClash = err.code === "ER_DUP_ENTRY" && /machine_id/.test(err.message || "");
        if (idClash && attempt < 5) continue; // someone took that ID — try the next one
        throw err;
      } finally {
        conn.release();
      }
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error("CREATE MACHINE ERROR:", err);
    res.status(500).json({ success: false, error: "Failed to create machine" });
  }
};

/* ===========================
   UPDATE MACHINE
   Partial update: only the fields present in the body are changed, so
   the form can send everything and older clients can send only a few.
   Vendor changes still go through assign / unassign.
=========================== */
exports.updateMachine = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { machineId } = req.params;
    const body = { ...(req.body || {}) };
    if (!has(body, "locationName") && has(body, "location")) body.locationName = body.location;

    const locationFields = readFields(body, LOCATION_INPUTS, { onlyPresent: true });
    const machineFields  = readFields(body, MACHINE_INPUTS,  { onlyPresent: true });
    if (has(body, "name"))   machineFields.name   = clean(body.name, 150);
    if (has(body, "module")) machineFields.module = parseModule(body.module);

    await conn.beginTransaction();

    const [[machine]] = await conn.query(
      `SELECT m.machine_id, m.module, m.location_id, m.owner_vendor_id, v.allowed_modules
       FROM machines m
       LEFT JOIN vendors v ON v.id = m.owner_vendor_id
       WHERE m.machine_id = ?
       FOR UPDATE`,
      [machineId]
    );
    if (!machine) throw notFound("Machine not found");

    // The module is part of the machine ID (SPK… / SPS…), so it can't change
    // after creation — create a new machine of the other type instead.
    if (machineFields.module && machineFields.module !== (machine.module || "KIOSK")) {
      throw badRequest(
        "A machine's type can't be changed because it is part of the machine ID. Create a new machine of the other type instead."
      );
    }
    delete machineFields.module;
    if (has(machineFields, "name") && !machineFields.name) {
      machineFields.name = machine.machine_id;
    }

    const locCols = Object.keys(locationFields);
    if (locCols.length) {
      if (machine.location_id) {
        await conn.query(
          `UPDATE locations SET ${locCols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
          [...locCols.map((c) => locationFields[c]), machine.location_id]
        );
      } else {
        const [r] = await conn.query(
          `INSERT INTO locations (${locCols.join(", ")}) VALUES (${locCols.map(() => "?").join(", ")})`,
          locCols.map((c) => locationFields[c])
        );
        machineFields.location_id = r.insertId;
      }
    }

    const mCols = Object.keys(machineFields);
    if (mCols.length) {
      await conn.query(
        `UPDATE machines SET ${mCols.map((c) => `${c} = ?`).join(", ")} WHERE machine_id = ?`,
        [...mCols.map((c) => machineFields[c]), machineId]
      );
    }

    await conn.query(
      `INSERT INTO audit_logs (machine_id, action_type, actor_admin_id, details)
       VALUES (?, 'MACHINE_UPDATED', ?, ?)`,
      [machineId, req.staff ? req.staff.id : null, JSON.stringify({ fields: [...locCols, ...mCols] })]
    );

    await conn.commit();

    res.json({
      success: true,
      message: "Machine updated successfully",
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, error: err.message, message: err.message });
    console.error("UPDATE MACHINE ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Unable to update machine",
      message: "Unable to update machine",
    });
  } finally {
    conn.release();
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
   MACHINE INFO — admin machines list with vendor + campus location,
   a ready-made `location_label` and online flag.
=========================== */
exports.getMachineInfo = async (req, res) => {
  try {
    const [machines] = await db.query(`
      SELECT
        ${MACHINE_LOCATION_COLUMNS},
        COALESCE(ps.total_jobs, 0) AS total_jobs,
        COALESCE(ps.revenue, 0)    AS revenue
      FROM machines m
      LEFT JOIN locations l ON l.id = m.location_id
      LEFT JOIN vendors   v ON v.id = m.owner_vendor_id
      ${PRINTED_STATS_JOIN}
      ORDER BY m.created_at DESC
    `);

    const now = Date.now();

    const result = machines.map((m) => {
      let isOnline = false;
      if (m.last_seen_at) {
        const diff = (now - new Date(m.last_seen_at).getTime()) / 1000;
        isOnline = diff < 120;
      }
      return { ...m, location_label: buildLocationLabel(m), is_online: isOnline };
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
   fullName     = contact PERSON, businessName = INSTITUTION name.
   allowedModules: 'KIOSK' | 'SHOP' | 'KIOSK,SHOP' (or an array).
=========================== */
exports.createVendor = async (req, res) => {
  try {
    const {
      fullName, email, phone, businessName, gstNumber, password,
      contactDesignation, altPhone, institutionType, panNumber, billingAddress, allowedModules,
    } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email and password are required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    const type = String(institutionType || "COLLEGE").trim().toUpperCase();
    if (!INSTITUTION_TYPES.includes(type)) {
      return res.status(400).json({ error: "Invalid institution type" });
    }

    const pan = clean(panNumber);
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.toUpperCase())) {
      return res.status(400).json({ error: "Invalid PAN (format: ABCDE1234F)" });
    }

    const gst = clean(gstNumber);
    if (gst && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gst.toUpperCase())) {
      return res.status(400).json({ error: "Invalid GST number (15 characters)" });
    }

    const modules = (Array.isArray(allowedModules) ? allowedModules : String(allowedModules || "KIOSK").split(","))
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
    if (!modules.length || modules.some((m) => !MODULES.includes(m))) {
      return res.status(400).json({ error: "allowedModules must be KIOSK, SHOP or both" });
    }
    const modulesValue = MODULES.filter((m) => modules.includes(m)).join(",");

    let cleanPhone, cleanAltPhone;
    try {
      cleanPhone    = parsePhone(phone, "phone");
      cleanAltPhone = parsePhone(altPhone, "alternate phone");
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const [[existing]] = await db.query(`SELECT id FROM vendors WHERE email=?`, [cleanEmail]);
    if (existing) return res.status(409).json({ error: "A vendor with this email already exists" });

    const hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO vendors
         (full_name, contact_designation, email, phone, alt_phone, password_hash,
          business_name, institution_type, gst_number, pan_number, billing_address,
          allowed_modules, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        fullName.trim(),
        clean(contactDesignation, 100),
        cleanEmail,
        cleanPhone,
        cleanAltPhone,
        hash,
        clean(businessName, 200),
        type,
        gst ? gst.toUpperCase() : null,
        pan ? pan.toUpperCase() : null,
        clean(billingAddress, 500),
        modulesValue,
      ]
    );

    res.json({
      success: true,
      vendor: {
        id: result.insertId,
        fullName,
        email: cleanEmail,
        businessName: clean(businessName, 200),
        institutionType: type,
        allowedModules: modulesValue,
      },
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
        v.id, v.full_name, v.contact_designation, v.email, v.phone, v.alt_phone,
        v.business_name, v.institution_type, v.gst_number, v.pan_number, v.billing_address,
        v.allowed_modules, v.status, v.created_at,
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
      `SELECT id, full_name, contact_designation, email, phone, alt_phone,
              business_name, institution_type, gst_number, pan_number, billing_address,
              allowed_modules, status, created_at
       FROM vendors WHERE id=?`,
      [vendorId]
    );
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const [machines] = await db.query(`
      SELECT
        ${MACHINE_LOCATION_COLUMNS},
        COALESCE(ps.total_jobs, 0) AS total_prints,
        COALESCE(ps.revenue, 0)    AS revenue
      FROM machines m
      LEFT JOIN locations l ON l.id = m.location_id
      LEFT JOIN vendors   v ON v.id = m.owner_vendor_id
      ${PRINTED_STATS_JOIN}
      WHERE m.owner_vendor_id = ?
      ORDER BY m.created_at DESC
    `, [vendorId]);

    const [[bank]] = await db.query(
      `SELECT * FROM bank_accounts WHERE vendor_id=? ORDER BY id DESC LIMIT 1`, [vendorId]
    );

    res.json({
      vendor,
      machines: machines.map((m) => ({ ...m, location_label: buildLocationLabel(m) })),
      bank: bank || null,
    });
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
   Assigning checks the vendor has bought the machine's module.
=========================== */
exports.assignMachineToVendor = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { vendorId } = req.body;
    if (!vendorId) return res.status(400).json({ error: "vendorId is required" });

    const [[vendor]] = await db.query(`SELECT id, allowed_modules FROM vendors WHERE id=?`, [vendorId]);
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const [[machine]] = await db.query(`SELECT module FROM machines WHERE machine_id=?`, [machineId]);
    if (!machine) return res.status(404).json({ error: "Machine not found" });

    try {
      assertVendorHasModule(vendor, machine.module || "KIOSK");
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await db.query(`UPDATE machines SET owner_vendor_id=? WHERE machine_id=?`, [vendorId, machineId]);

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
      SELECT v.id AS vendor_id, COALESCE(v.business_name, v.full_name) AS vendor_name,
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
   `machine` now also carries vendor, campus location, on-site contact
   and timings for the detail page header.
=========================== */
exports.getMachineJobs = async (req, res) => {
  try {
    const { machineId } = req.params;

    const [[machine]] = await db.query(
      `SELECT ${MACHINE_LOCATION_COLUMNS}
       FROM machines m
       LEFT JOIN locations l ON l.id = m.location_id
       LEFT JOIN vendors   v ON v.id = m.owner_vendor_id
       WHERE m.machine_id=?`,
      [machineId]
    );
    if (!machine) return res.status(404).json({ error: "Machine not found" });
    machine.location_label = buildLocationLabel(machine);

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