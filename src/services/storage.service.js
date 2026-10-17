// src/services/storage.service.js
// Customer documents live in a PRIVATE Cloudflare R2 bucket (S3-compatible).
//
//   Phone  ──PUT (signed URL, 10 min)──►  R2  ──GET (signed URL, 10 min)──►  Raspberry Pi
//
// Files never pass through this server on the way in or out, so Railway
// bandwidth stays near zero. The server only:
//   - creates short-lived signed URLs
//   - reads a PDF once to count its pages (R2 → Railway is free)
//   - deletes the file after printing / when abandoned
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const env = require("../config/env");

let client = null;
if (env.R2_ENABLED) {
  client = new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: env.R2_FORCE_PATH_STYLE,
    // Only send checksums when the API requires them. Without this, newer SDK
    // versions add checksum headers to signed upload URLs that browsers can't send.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const Bucket = env.R2_BUCKET;

function isEnabled() {
  return !!client;
}

function requireClient() {
  if (!client) {
    const err = new Error("File storage is not configured");
    err.status = 503;
    throw err;
  }
}

/* Signed URL the customer's phone PUTs the file to.
   The browser MUST send exactly this Content-Type header, or R2 rejects it. */
async function createUploadUrl(key, contentType) {
  requireClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn: env.R2_UPLOAD_URL_TTL_SECONDS }
  );
}

/* Signed URL the kiosk GETs the file from (no other headers needed). */
async function createDownloadUrl(key, fileName) {
  requireClient();
  const safeName = String(fileName || "document").replace(/["\\\r\n]/g, "_");
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeName}"`,
    }),
    { expiresIn: env.R2_DOWNLOAD_URL_TTL_SECONDS }
  );
}

/* → { size, contentType } or null if the object doesn't exist */
async function getInfo(key) {
  requireClient();
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { size: r.ContentLength, contentType: r.ContentType };
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/* Whole object as a Buffer (used to count PDF pages). */
async function getBuffer(key) {
  requireClient();
  const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  const bytes = await r.Body.transformToByteArray();
  return Buffer.from(bytes);
}
/* Upload bytes from the server (used to save the converted PDF). */
async function put(key, body, contentType) {
  requireClient();
  await client.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    })
  );
}
/* Deleting is free on R2, and deleting a missing key is not an error. */
async function remove(key) {
  requireClient();
  await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
}


module.exports = { isEnabled, createUploadUrl, createDownloadUrl, getInfo, getBuffer, put, remove };
