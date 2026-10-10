// src/middleware/errorHandler.js
// Last middleware in the chain: turns any thrown error into a JSON response
// (instead of Express's default HTML page).
function notFound(req, res) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("UNHANDLED ERROR:", err);

  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
}

module.exports = { notFound, errorHandler };
