// src/services/file.service.js
// Deleting customer documents. Once a file is gone, the job row is
// KEPT (for revenue/history) and only its file_path is cleared.
//
// file_path holds the R2 object key, e.g. "jobs/JOB_ab12.../9f3c....pdf".
// Rows from before the R2 switch hold an absolute disk path ("/app/uploads/...");
// those files were on Railway's temporary disk and are already gone, so for
// them we only clear the column.
const path = require("path");
const db = require("../database/db");
const storage = require("./storage.service");

const isStorageKey = (p) => !!p && !path.isAbsolute(p);

async function deleteJobFile(jobId, filePath) {
  if (isStorageKey(filePath)) {
    try {
      await storage.remove(filePath);
    } catch (e) {
      // Keep file_path so the cleanup job retries; R2's lifecycle rule is the final safety net.
      console.error("FILE DELETE ERROR:", jobId, e.message);
      return false;
    }
  }
  try {
    await db.query(`UPDATE print_jobs SET file_path=NULL WHERE job_id=?`, [jobId]);
  } catch (e) {
    // If file_path is NOT NULL in your schema, run:
    //   ALTER TABLE print_jobs MODIFY file_path VARCHAR(512) NULL;
    console.error("CLEAR file_path ERROR:", e.message);
  }
  return true;
}

module.exports = { deleteJobFile, isStorageKey };
