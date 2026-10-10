// src/config/fileTypes.js
// Which documents customers may upload, and the size limit.
// Must match the frontend's ALLOWED_EXTENSIONS / MAX_FILE_SIZE in src/config.js.

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Extension → the Content-Type the file is stored with in R2.
// The backend decides the type from the extension, so a browser that sends an
// empty or odd type (some do for .doc / .tiff) still works.
const EXT_TO_MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const ALLOWED_LABEL = "PDF, DOC, DOCX, TXT, JPG, PNG, GIF, BMP, WEBP, TIFF";

module.exports = { MAX_FILE_SIZE, EXT_TO_MIME, ALLOWED_LABEL };
