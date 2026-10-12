import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const oldUri =
  "mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority";
const newUri = process.env.MONGODB_URI;

async function syncDatabases() {
  console.log("🔌 Connecting to OLD DB (3wheelertvs)...");
  const oldConn = await mongoose.createConnection(oldUri).asPromise();
  console.log("✅ Connected to OLD DB:", oldConn.name);

  console.log("🔌 Connecting to NEW DB (3wheelertvs_dev)...");
  const newConn = await mongoose.createConnection(newUri).asPromise();
  console.log("✅ Connected to NEW DB:", newConn.name);

  const collections = [
    "responses",
    "formsessions",
    "reviews",
    "attendances",
    "users",
    "forms",
    "chatmessages",
    "shifts",
    "tenants",
    "swaplogs",
    "loginlogs",
    "activitylogs",
  ];

  console.log("\n🚀 Starting fast ID-based sync...\n");

  const totalMigrated = {};

  for (const colName of collections) {
    const oldCol = oldConn.db.collection(colName);
    const newCol = newConn.db.collection(colName);

    // Get all _ids from NEW DB
    const newIdDocs = await newCol.find({}, { projection: { _id: 1 } }).toArray();
    const newIdSet = new Set(newIdDocs.map((d) => d._id.toString()));

    // Get all _ids from OLD DB (lightweight, only _id)
    const oldIdDocs = await oldCol.find({}, { projection: { _id: 1 } }).toArray();
    const missingIds = oldIdDocs
      .filter((d) => !newIdSet.has(d._id.toString()))
      .map((d) => d._id);

    console.log(`🔍 [${colName}]:`);
    console.log(`   Old count: ${oldIdDocs.length} | New count: ${newIdDocs.length}`);
    console.log(`   Missing in NEW DB: ${missingIds.length}`);

    if (missingIds.length === 0) {
      console.log(`   ✨ Up to date.\n`);
      totalMigrated[colName] = 0;
      continue;
    }

    console.log(`   ⏳ Fetching and copying ${missingIds.length} missing documents...`);

    let inserted = 0;
    // Process in batches of 200
    for (let i = 0; i < missingIds.length; i += 200) {
      const batchIds = missingIds.slice(i, i + 200);
      const docsToCopy = await oldCol.find({ _id: { $in: batchIds } }).toArray();

      if (docsToCopy.length > 0) {
        try {
          await newCol.insertMany(docsToCopy, { ordered: false });
          inserted += docsToCopy.length;
        } catch (insertErr) {
          if (insertErr.result?.insertedCount) {
            inserted += insertErr.result.insertedCount;
          } else if (insertErr.insertedDocs) {
            inserted += insertErr.insertedDocs.length;
          }
          console.warn(`   ⚠️ Notice: ${insertErr.message?.slice(0, 100)}`);
        }
      }
      process.stdout.write(`   ... copied ${inserted}/${missingIds.length}\r`);
    }

    console.log(`\n   ✅ Successfully copied ${inserted} documents into NEW DB!\n`);
    totalMigrated[colName] = inserted;
  }

  console.log("==========================================");
  console.log("🎉 SYNC COMPLETED SUCCESSFULLY:");
  for (const [col, count] of Object.entries(totalMigrated)) {
    console.log(`   - ${col}: ${count} newly synced records`);
  }
  console.log("==========================================");

  await oldConn.close();
  await newConn.close();
}

syncDatabases().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
