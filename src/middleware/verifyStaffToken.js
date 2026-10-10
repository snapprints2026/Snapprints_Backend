// middleware/verifyStaffToken.js
const jwt = require("jsonwebtoken");

/**
 * Factory — returns middleware that verifies a JWT and (optionally)
 * enforces a specific role claim ("admin" | "vendor").
 * Mirrors the pattern used by verifyCustomerToken / verifyMachine in server.js.
 */
function verifyStaffToken(requiredRole) {
  return (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (!token) return res.status(401).json({ error: "No token provided" });

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (requiredRole && decoded.role !== requiredRole) {
        return res.status(403).json({ error: "Forbidden — wrong role for this resource" });
      }

      req.staff = decoded; // { id, role, name, email }
      next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

module.exports = {
  verifyAdminToken:  verifyStaffToken("admin"),
  verifyVendorToken: verifyStaffToken("vendor"),
};