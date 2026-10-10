# SnapPrints backend — changes

## Cloudflare R2 file storage (latest)

Customer documents no longer touch Railway's disk. They go **phone → R2 → Raspberry Pi** using short-lived signed links, so a redeploy can't lose a paid customer's file and Railway bandwidth stays near zero.

### New upload flow (frontend already updated)

| Step | Call | What happens |
|---|---|---|
| 1 | `POST /api/upload-url` `{ fileName, fileSize, machineId, color, copies, paperSize, printSide }` | Checks type, size (≤ 50 MB), machine and copies. Creates the job (0 pages, can't be paid yet). Returns `{ jobId, uploadUrl, contentType, expiresIn }`. |
| 2 | `PUT <uploadUrl>` with header `Content-Type: <contentType>` | Browser uploads straight to R2. |
| 3 | `POST /api/jobs/:jobId/complete-upload` | Checks the file arrived and its size, counts PDF pages, returns `{ jobId, pages }`. Safe to retry. |

`POST /api/upload-job` (old multipart upload) now returns `410` asking the customer to refresh. `create-payment` refuses jobs whose upload isn't finished.

### Kiosk download

- `POST /api/kiosk/unlock` now also returns **`downloadUrl`** — a plain R2 link (10 min). The Pi just GETs it, no headers.
- `GET /api/kiosk/jobs/:jobId/file` (signed kiosk headers) still works: it **redirects (302)** to the R2 link, so Pi code that follows redirects keeps working. Add `?format=json` to get `{ url, fileName, expiresIn }` instead.
- The old public `/uploads/<file>` path and `LEGACY_PUBLIC_UPLOADS` are gone.

### Deleting files

- After `mark-printed` / `mark-failed` the R2 file is deleted and `file_path` set to NULL (row kept).
- The 5-minute cleanup job finds files **through the database** (no bucket listing — deletes are free on R2, listing is not): abandoned unpaid uploads after 30 min, and any file older than `UPLOAD_MAX_AGE_MINUTES` unless the job is PRINTING or PAID with a valid OTP.
- The bucket's lifecycle rule (delete after 1 day) is the safety net.

### Other

- `multer` removed; `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` added.
- Fixed PDF page counting for small files ("bad XRef entry" when Node handed pdf.js a pooled Buffer).
- New settings: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (+ optional TTLs). Remove `UPLOAD_DIR` and `LEGACY_PUBLIC_UPLOADS` from Railway.

---

## Earlier: restructure & fixes

All API paths are the same as before, and so is every route's response shape, apart from the extra fields noted below.
Entry point is now `src/server.js` (`npm start`).

## Folder structure

```
src/
  server.js            HTTP server + socket + cron + listen
  app.js               Express app, CORS, routes, JSON error handler
  config/              env.js, cors.js, razorpay.js, fileTypes.js
  middleware/          verifyMachine, verifyCustomerToken, verifyStaffToken, errorHandler
  routes/              kiosk, job, payment, machine (+ admin, auth, customer, vendor, demo)
  controllers/         kiosk, job, payment, machine (+ admin, vendor)
  services/            pricing, audit, payment, pdf, file, storage (R2)
  jobs/cleanup.cron.js
  database/db.js
  socket/socket.js
scripts/               create-admin.js, generate-daily-stats.js
```

## What changed

| # | Change |
|---|---|
| 1 | **Login always sends an OTP.** A known phone number no longer logs in by itself. Skipping the OTP next time now works through the saved 30-day token. |
| 2 | **Job rows are never deleted** once printed, failed or expired, so the day, month, 6-month and year revenue figures stay correct. Only the file is deleted, and `file_path` is set to NULL. |
| 3 | **`/uploads` is no longer public.** Kiosks download through `GET /api/kiosk/jobs/:jobId/file` using signed headers. That route only works for the kiosk's own job and only while the job is PAID or PRINTING. |
| 3 | **Socket:** `payment_success` no longer contains `filePath`. Kiosks can join a private room with `kiosk:join`. Socket CORS now uses the same allowed-origin list as the API, not `*`. |
| 3 | **File cleanup:** every 5 minutes, any upload older than 30 minutes is deleted unless its job is printing or paid with a valid OTP. Abandoned unpaid uploads (CREATED for more than 30 minutes) are removed together with their file. |
| 3 | Uploaded files get random names. The original name is kept only in the DB. |
| 4 | **Job IDs are random** (`JOB_` + 16 hex characters). |
| 4 | **Job routes need the customer's login** and only work for that customer's own jobs: `upload-job`, `job-summary`, `PATCH job`, `job-status`, `create-payment`. |
| – | `mark-printed` and `mark-failed` only work for the calling kiosk's own jobs. `mark-failed` also deletes the file. |
| – | The Razorpay secret is no longer printed in logs. There is one shared Razorpay client, and the broken `razorpay.js` is gone. |
| – | Errors are always JSON, including wrong file type, files over 50 MB and unknown routes. |
| – | Uploads are validated: the file must be present, copies must be 1–100, and the machine must exist and be active. |
| – | Heartbeats are no longer copied into `audit_logs`. They are already stored in `machine_heartbeat_logs`. |
| – | OTPs use `crypto.randomInt`. Payment signatures are compared in constant time. |
| – | `generate-daily-stats.js` uses the normal DB settings instead of fixed root/root login details. |

## Demo mode (no OTP)

One Railway variable switches customer login on and off. No code needs to be commented out.

| `REQUIRE_CUSTOMER_LOGIN` | Behaviour |
|---|---|
| `false` (demo) | Scan QR, upload, pay, print. No login needed. Jobs are saved with `customer_id = NULL`. |
| `true` or not set (launch) | The customer must verify a mobile OTP before uploading. |

- **Where it is used:** `customerAuth` in `src/middleware/verifyCustomerToken.js`. It is applied in `job.routes.js` and `payment.routes.js`.
- **Demo-mode privacy:** a guest can only open guest jobs, using the random jobId. A logged-in customer's jobs stay private.

## Frontend changes needed

1. **Send the token on job and payment calls.** Add `Authorization: Bearer <token>` to `upload-job`, `job-summary/:id`, `PATCH job/:id`, `job-status/:id` and `create-payment`.
2. **Skip login for returning users.** When the upload page opens (`?mh=MH100`), if a token is saved, call `GET /api/customer/me`.
   - **200:** go straight to upload.
   - **401:** show the mobile number screen.
3. **Login screen.** `/api/auth/login` now always returns `{ status: "otp_sent" }`. Show the OTP box every time.

## Raspberry Pi change needed

After unlock, download from `fileUrl` (new field in the unlock response) and send the **same signed headers** as other kiosk calls. For a GET request the body is `{}`, so sign `machineId + timestamp + "{}"`.

```python
import time, hmac, hashlib, requests

def signed_headers(machine_id, api_key, body_json="{}"):
    ts = str(int(time.time() * 1000))
    sig = hmac.new(api_key.encode(), (machine_id + ts + body_json).encode(), hashlib.sha256).hexdigest()
    return {"x-machine-id": machine_id, "x-timestamp": ts, "x-api-key": api_key, "x-signature": sig}

# after POST /api/kiosk/unlock returned `job`
url = API_BASE.replace("/api", "") + job["fileUrl"]          # https://.../api/kiosk/jobs/JOB_xxx/file
r = requests.get(url, headers=signed_headers(MACHINE_ID, API_KEY), timeout=60)
r.raise_for_status()
open("/tmp/print_job.pdf", "wb").write(r.content)
```

The Pi can optionally receive payment notifications in real time:
`socket.emit("kiosk:join", {machineId, timestamp, apiKey, signature})`, where the signature is made the same way over `"{}"`. Then listen for `payment_success`, which contains only `{ jobId, machineId }`.

**Transition:** until every Pi has this update, set the Railway variable `LEGACY_PUBLIC_UPLOADS=true`. That keeps the old `/uploads/<file>` links working. Remove it as soon as the Pis are updated, because while it is on, files are public again.

## Deploy checklist

1. **Change the Razorpay keys and the JWT secret.** The old ones were in the shared zip, in `payment.env`, and in comments in the old `razorpay.js`.
2. **Railway.** The start command is now `node src/server.js` (set in `railway.json`). Set the variables listed in `.env.example`.
3. **Git.** Run `git rm -r --cached uploads .env payment.env` and commit. That removes them from git but keeps them on disk. To remove them from old commits as well, use `git filter-repo`.
4. **Database (only if needed).** If marking a job printed logs `CLEAR file_path ERROR`, run:
   ```sql
   ALTER TABLE print_jobs MODIFY file_path VARCHAR(512) NULL;
   ```

## Still open (unchanged on purpose, so nothing breaks)

- **Some admin routes need no login:** `/stats`, `/createmachine`, `/machines` (edit and delete), `/revenue` and others. Add `verifyAdminToken` once the admin frontend sends its token.
- **`/api/register-machine`** still needs no login and still returns the stored plain API key.
