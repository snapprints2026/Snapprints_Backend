// src/services/pdf.service.js
// Best-effort page count. PDFs are counted exactly; every other type
// (doc/docx/txt/images) is priced as 1 page until a converter is added
// (e.g. LibreOffice headless → PDF → count).
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

/* buffer = the file's bytes, ext = ".pdf", ".docx", ... */
async function getPageCount(buffer, ext) {
  if (ext === ".pdf") {
    // Fresh Uint8Array copy: Node may hand back a small Buffer that is a slice of a
    // shared memory pool, and pdf.js would then read the wrong bytes ("bad XRef entry").
    const pdf = await pdfParse(new Uint8Array(buffer));
    return pdf.numpages;
  }
  return 1;
}

module.exports = { getPageCount };
