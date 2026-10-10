// src/app.js — Express app: middleware, routes, error handling.
const express = require("express");
const cors = require("cors");
const env = require("./config/env");
const { corsOptions } = require("./config/cors");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy → correct req.ip

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

// Customer documents are never served from here. They live in a private
// Cloudflare R2 bucket; kiosks get short-lived signed links.

/* ── Health check (Railway) ── */
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

/* ── Routes ── */
app.use("/api/admin",        require("./routes/admin.routes"));
app.use("/api/auth",         require("./routes/auth.routes"));
app.use("/api/customer",     require("./routes/customer.routes"));
app.use("/api/vendor",       require("./routes/vendor.routes"));
app.use("/api/request-demo", require("./routes/demo.routes"));
app.use("/api/machines",     require("./routes/machine.routes"));
app.use("/api",              require("./routes/kiosk.routes"));
app.use("/api",              require("./routes/job.routes"));
app.use("/api",              require("./routes/payment.routes"));

/* ── 404 + errors (always JSON) ── */
app.use(notFound);
app.use(errorHandler);

module.exports = app;
