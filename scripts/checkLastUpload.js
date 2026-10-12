import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const uri = process.env.MONGODB_URI;

async function checkLastUpload() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log(`=== Connected to ${mongoose.connection.name} ===\n`);

  // 1. Last Bulk Import History
  const lastBulkImport = await db
    .collection("bulkimporthistories")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(3)
    .toArray();

  console.log("📌 LATEST BULK IMPORTS (bulkimporthistories):");
  lastBulkImport.forEach((b, i) => {
    console.log(`[${i + 1}] File: ${b.fileName || b.filename || "N/A"}`);
    console.log(`    Date (createdAt): ${b.createdAt}`);
    console.log(`    Batch ID: ${b.batchId}`);
    console.log(`    Total Records: ${b.dataCount?.total || b.totalCount || b.recordCount || "N/A"}`);
    console.log(`    Successful: ${b.dataCount?.success || "N/A"}`);
    console.log(`    Uploaded By: ${b.uploadedBy || b.submittedBy || "N/A"}`);
  });

  // 2. Last Responses (Inspection Submissions)
  const lastResponses = await db
    .collection("responses")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(3)
    .toArray();

  console.log("\n📌 LATEST RESPONSES / INSPECTION SUBMISSIONS (responses):");
  lastResponses.forEach((r, i) => {
    console.log(`[${i + 1}] ID: ${r._id}`);
    console.log(`    Created At: ${r.createdAt}`);
    console.log(`    Submitted At: ${r.submittedAt || "N/A"}`);
    console.log(`    Submitted By: ${r.submittedBy || r.inspectorName || "N/A"}`);
    console.log(`    Chassis / VIN: ${r.chassisNumber || "N/A"}`);
    console.log(`    Batch ID: ${r.batchId || "Manual/Web submission"}`);
  });

  // 3. Last Form Session
  const lastSession = await db
    .collection("formsessions")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .toArray();

  if (lastSession.length > 0) {
    console.log("\n📌 LATEST FORM SESSION:");
    console.log(`    Created At: ${lastSession[0].createdAt}`);
    console.log(`    Updated At: ${lastSession[0].updatedAt}`);
  }

  await mongoose.disconnect();
}

checkLastUpload().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
