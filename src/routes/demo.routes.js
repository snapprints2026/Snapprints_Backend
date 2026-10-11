// routes/demo.routes.js
const express = require("express");
const router  = express.Router();
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const INTEREST_LABELS = {
  own_kiosk: "Wants to own a SnapPrints kiosk",
  host_kiosk: "Has a location, wants to host a kiosk",
  custom_solution: "Needs a custom solution",
};

// Visitors' text goes into an HTML email, so escape it (stops someone
// injecting links/HTML into the email you receive).
const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/* ═══════════════════════════════════════════════════════════
   POST /api/request-demo
   Accepts the website's Request Demo form:
     { name, company, email, phone, city, organization, message }
   and the older field names too:
     { organisation, interestType, country, state, language }
   Sends a notification email via Resend to TO_EMAIL.
═══════════════════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  try {
    if (!resend) {
      console.warn("RESEND_API_KEY not set — demo request not emailed:", req.body);
      return res.status(503).json({ error: "Demo request service unavailable" });
    }
    if (!process.env.TO_EMAIL) {
      console.warn("TO_EMAIL not set — demo request not emailed");
      return res.status(503).json({ error: "Demo request service unavailable" });
    }

    const b = req.body || {};

    const name         = clean(b.name);
    const email        = clean(b.email);
    const phone        = clean(b.phone);
    // Company / college name: form sends "company"; older clients sent "organisation"
    const company      = clean(b.company) || clean(b.organisation);
    // Organization type dropdown (College, Corporate, ...): form sends "organization"
    const orgType      = clean(b.organization) || clean(b.orgType);
    const interestType = clean(b.interestType);
    const city         = clean(b.city);
    const state        = clean(b.state);
    const country      = clean(b.country);
    const language     = clean(b.language);
    const message      = clean(b.message);

    const missing = [];
    if (!name)    missing.push("name");
    if (!email)   missing.push("email");
    if (!phone)   missing.push("phone");
    if (!company) missing.push("company");
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
    }

    const interestLabel = INTEREST_LABELS[interestType] || interestType || "—";
    const location = [city, state, country].filter(Boolean).join(", ") || "—";

    const { error } = await resend.emails.send({
      from: "SnapPrints Demo Requests <onboarding@resend.dev>",
      to: process.env.TO_EMAIL,
      replyTo: email,
      subject: `New demo request — ${company}`,
      html: `
        <h2>New Demo Request</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Company / College:</strong> ${escapeHtml(company)}</p>
        <p><strong>Organization type:</strong> ${escapeHtml(orgType || "—")}</p>
        <p><strong>Interested in:</strong> ${escapeHtml(interestLabel)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(phone)}</p>
        <p><strong>Location:</strong> ${escapeHtml(location)}</p>
        <p><strong>Preferred Language:</strong> ${escapeHtml(language || "—")}</p>
        <p><strong>Message:</strong><br/>${escapeHtml(message || "—").replace(/\n/g, "<br/>")}</p>
      `,
    });

    // Resend returns { error } instead of throwing (e.g. TO_EMAIL not allowed
    // while sending from onboarding@resend.dev).
    if (error) {
      console.error("RESEND ERROR:", error);
      return res.status(502).json({ error: "Failed to send demo request" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("REQUEST DEMO ERROR:", err);
    res.status(500).json({ error: "Failed to send demo request" });
  }
});

module.exports = router;