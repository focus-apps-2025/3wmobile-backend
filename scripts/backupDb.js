import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("❌ No MONGODB_URI found in .env");
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.resolve(__dirname, `../../backups/db-backup-${timestamp}`);

async function runBackup() {
  console.log(`🔌 Connecting to MongoDB Atlas...`);
  await mongoose.connect(uri);
  console.log(`✅ Connected successfully to: ${mongoose.connection.name}`);

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const collections = await mongoose.connection.db.listCollections().toArray();
  console.log(`📦 Found ${collections.length} collections.\n`);

  const colDetails = [];
  for (const col of collections) {
    const colName = col.name;
    const count = await mongoose.connection.db.collection(colName).countDocuments();
    colDetails.push({ name: colName, count });
  }

  colDetails.sort((a, b) => a.count - b.count);

  const summary = {
    database: mongoose.connection.name,
    timestamp: new Date().toISOString(),
    collections: {},
    totalDocuments: 0,
  };

  for (const { name: colName, count } of colDetails) {
    summary.collections[colName] = count;
    summary.totalDocuments += count;

    if (count === 0) {
      console.log(`  ⚪ ${colName} (0 documents) - skipping`);
      continue;
    }

    console.log(`  ⏳ Exporting ${colName} (${count} documents)...`);
    const collection = mongoose.connection.db.collection(colName);
    const filePath = path.join(backupDir, `${colName}.json`);
    const writeStream = fs.createWriteStream(filePath, { encoding: "utf8" });

    writeStream.write("[\n");
    const cursor = collection.find({}).batchSize(500);

    let isFirst = true;
    let exported = 0;

    for await (const doc of cursor) {
      if (!isFirst) {
        writeStream.write(",\n");
      }
      writeStream.write(JSON.stringify(doc));
      isFirst = false;
      exported++;

      if (exported % 1000 === 0 || exported === count) {
        process.stdout.write(`     -> ${exported}/${count} exported (${Math.round((exported / count) * 100)}%)\r`);
      }
    }

    writeStream.write("\n]");
    await new Promise((resolve, reject) => {
      writeStream.end(resolve);
      writeStream.on("error", reject);
    });

    console.log(`\n  ✅ Saved ${colName} (${count} docs)`);
  }

  fs.writeFileSync(
    path.join(backupDir, "backup-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log(`\n🎉 Full Backup Complete!`);
  console.log(`📁 Saved to: ${backupDir}`);
  console.log(`📊 Total Documents Saved: ${summary.totalDocuments}`);

  await mongoose.disconnect();
}

runBackup().catch((err) => {
  console.error("❌ Backup failed:", err);
  process.exit(1);
});
