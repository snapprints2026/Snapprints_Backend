// src/server.js — entry point: HTTP server + Socket.io + cron + listen.
const env = require("./config/env");
const http = require("http");
const app = require("./app");
const { initSocket } = require("./socket/socket");
const { startCleanupCron } = require("./jobs/cleanup.cron");

process.on("uncaughtException",  (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

const server = http.createServer(app);
initSocket(server);
startCleanupCron();

server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${env.PORT}`);
  console.log(`✅ API_BASE: ${env.API_BASE_URL}`);
});
