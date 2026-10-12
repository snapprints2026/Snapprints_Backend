// src/services/convert.service.js
// Turns every non-PDF upload into a print-ready PDF, so the Raspberry Pi
// only ever receives PDFs and the price uses the real page count.
//   Images (JPG PNG WEBP GIF TIFF BMP) → one A4 page per image, auto-rotated,
//                                        landscape page for wide images.
//   Documents (DOC DOCX TXT)           → LibreOffice (installed by the Dockerfile).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const sharp = require("sharp");
const bmp = require("bmp-js");
const { PDFDocument } = require("pdf-lib");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".bmp"]);
const OFFICE_EXTS = new Set([".doc", ".docx", ".txt"]);

const A4 = { w: 595.28, h: 841.89 }; // points
const MARGIN = 18;                   // ≈ 6 mm
const MAX_PX = 3508;                 // A4 long side at 300 dpi
const OFFICE_TIMEOUT_MS = 60 * 1000;

function findOnPath(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const name of names) {
    for (const d of dirs) {
      const p = path.join(d, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* keep looking */ }
    }
  }
  return null;
}
const SOFFICE = process.env.SOFFICE_PATH || findOnPath(["soffice", "libreoffice"]);
console.log("CONVERTER — Word/TXT to PDF:", SOFFICE ? `ready (${SOFFICE})` : "LibreOffice MISSING (DOC/DOCX/TXT uploads refused)");

function canConvert(ext) {
  if (ext === ".pdf" || IMAGE_EXTS.has(ext)) return true;
  if (OFFICE_EXTS.has(ext)) return !!SOFFICE;
  return false;
}

function decodeBmp(buffer) {
  const img = bmp.decode(buffer); // ABGR
  const rgba = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = img.data[i + 3];
    rgba[i + 1] = img.data[i + 2];
    rgba[i + 2] = img.data[i + 1];
    rgba[i + 3] = 255;
  }
  return { input: rgba, opts: { raw: { width: img.width, height: img.height, channels: 4 } } };
}

async function imageToPdf(buffer, ext) {
  let source = { input: buffer, opts: {} };
  if (ext === ".bmp") source = decodeBmp(buffer);

  let pages = 1; // GIF: first frame only. TIFF: every page.
  if (ext === ".tif" || ext === ".tiff") {
    const meta = await sharp(source.input, source.opts).metadata();
    pages = Math.max(1, Math.min(meta.pages || 1, 200));
  }

  const pdf = await PDFDocument.create();
  for (let p = 0; p < pages; p++) {
    const jpeg = await sharp(source.input, { ...source.opts, page: p })
      .rotate()                              // phone photo orientation
      .flatten({ background: "#ffffff" })    // transparent → white
      .resize({ width: MAX_PX, height: MAX_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const img = await pdf.embedJpg(jpeg);
    const landscape = img.width > img.height;
    const pw = landscape ? A4.h : A4.w;
    const ph = landscape ? A4.w : A4.h;
    const scale = Math.min((pw - 2 * MARGIN) / img.width, (ph - 2 * MARGIN) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    pdf.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return Buffer.from(await pdf.save());
}

// At most 2 LibreOffice conversions at once; the rest wait.
const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (err) {
        err.message += ` | ${String(stderr || stdout).trim().slice(0, 300)}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function officeToPdf(buffer, ext) {
  if (!SOFFICE) throw new Error("LibreOffice is not installed");
  return withSlot(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sp-convert-"));
    try {
      const input = path.join(dir, `in${ext}`);
      await fs.promises.writeFile(input, buffer);
      const args = [
        "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
        `-env:UserInstallation=file://${path.join(dir, "profile")}`,
      ];
      if (ext === ".txt") args.push("--infilter=Text (encoded):UTF8,LF,,,"); // Hindi, Marathi, ₹
      args.push("--convert-to", "pdf", "--outdir", dir, input);

      await run(SOFFICE, args, OFFICE_TIMEOUT_MS);
      const out = path.join(dir, "in.pdf");
      if (!fs.existsSync(out)) throw new Error("LibreOffice produced no PDF");
      return await fs.promises.readFile(out);
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function toPdf(buffer, ext) {
  if (ext === ".pdf") return buffer;
  if (IMAGE_EXTS.has(ext)) return imageToPdf(buffer, ext);
  if (OFFICE_EXTS.has(ext)) return officeToPdf(buffer, ext);
  throw new Error(`No converter for ${ext}`);
}

const pdfNameFor = (fileName) => {
  const base = path.basename(String(fileName || "document"), path.extname(String(fileName || "")));
  return `${base || "document"}.pdf`;
};

module.exports = { toPdf, canConvert, pdfNameFor };