// src/config/cors.js
// One origin list shared by Express and Socket.io.
const allowedOrigins = [
  "https://www.snapprints.in",
  "https://snapprints.in",
  "https://upload.snapprints.in",
  "https://snap-prints.vercel.app",
  "https://snapprints-eight.vercel.app",
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server, curl, Raspberry Pi
  return (
    allowedOrigins.includes(origin) ||
    origin.endsWith(".vercel.app") ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin)
  );
}

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn("CORS blocked:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

module.exports = { allowedOrigins, isAllowedOrigin, corsOptions };
