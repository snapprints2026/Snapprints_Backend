// src/services/pricing.service.js
// Price per printed unit (₹):  B&W single 2, B&W duplex 4, colour single 5, colour duplex 10.
// A duplex unit is one sheet (2 pages).
function calculatePrice(job) {
  const bw = job.color === "bw";
  const duplex = job.print_side === "duplex";
  const rate = bw ? (duplex ? 4 : 2) : (duplex ? 10 : 5);
  const units = duplex
    ? Math.ceil(job.total_pages / 2) * job.copies
    : job.total_pages * job.copies;
  return { units, rate, total: units * rate, paise: units * rate * 100 };
}

module.exports = { calculatePrice };
