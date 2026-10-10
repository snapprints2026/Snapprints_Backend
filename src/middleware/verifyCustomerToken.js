// middleware/verifyCustomerToken.js
const jwt = require("jsonwebtoken");

// Strict — blocks the request if token missing/invalid
function verifyCustomerToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing or expired session" });

    req.customer = jwt.verify(token, process.env.JWT_SECRET); // { customerId, mobile, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Lenient — attaches req.customer if a valid token is present, otherwise continues anonymously.
// Used on the upload routes so guest uploads (if you ever allow them) don't break.
function optionalCustomerToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token) req.customer = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // invalid/expired token → treat as anonymous, don't block the upload
  }
  next();
}

/* Used on the upload/job/payment routes.
   - REQUIRE_CUSTOMER_LOGIN=true  (launch) → token required
   - REQUIRE_CUSTOMER_LOGIN=false (demo)   → token optional; guests allowed */
function customerAuth(req, res, next) {
  const env = require("../config/env");
  return env.REQUIRE_CUSTOMER_LOGIN
    ? verifyCustomerToken(req, res, next)
    : optionalCustomerToken(req, res, next);
}

/* SQL condition limiting a query to jobs this requester owns.
   Logged-in customer → only their jobs.
   Guest (demo mode)  → only guest jobs (customer_id IS NULL); the random
                         jobId is what identifies the job. */
function jobOwnerFilter(req) {
  return req.customer
    ? { sql: "customer_id=?", params: [req.customer.customerId] }
    : { sql: "customer_id IS NULL", params: [] };
}

module.exports = { verifyCustomerToken, optionalCustomerToken, customerAuth, jobOwnerFilter };