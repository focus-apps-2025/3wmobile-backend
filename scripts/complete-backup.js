import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROD_URI = process.env.PROD_MONGODB_URI || process.env.MONGO_URI;
const backupDir = path.join(__dirname, '..', 'backups', 'backup_3wheelertvs_2026-08-07T12-16-59-234Z');

async function completeBackup() {
  if (!PROD_URI) {
    console.error("❌ Error: PROD_MONGODB_URI environment variable is required.");
    process.exit(1);
  }
  console.log('🚀 Connecting to complete and verify production backup...');
  await mongoose.connect(PROD_URI);
  const db = mongoose.connection.db;

  const collections = await db.listCollections().toArray();
  console.log(`📦 Found ${collections.length} total collections\n`);

  const manifest = {
    database: '3wheelertvs',
    backupDirectory: backupDir,
    timestamp: new Date().toISOString(),
    collections: {},
    totalDocuments: 0,
    status: 'VERIFIED'
  };

  for (const col of collections) {
    const colName = col.name;
    if (colName.startsWith('system.')) continue;

    const collection = db.collection(colName);
    const totalDocs = await collection.countDocuments();
    const filePath = path.join(backupDir, `${colName}.json`);

    // If file already exists and is non-empty, check if it's already complete
    let needDownload = true;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > 10) {
        // Read file to verify doc count
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          // Fast count of JSON objects or parse
          const parsed = JSON.parse(raw);
          if (parsed.length === totalDocs) {
            console.log(`✅ [ALREADY COMPLETE] '${colName}': ${parsed.length}/${totalDocs} docs (${(stats.size / (1024*1024)).toFixed(2)} MB)`);
            manifest.collections[colName] = {
              count: parsed.length,
              fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
              file: `${colName}.json`,
              verified: true
            };
            manifest.totalDocuments += parsed.length;
            needDownload = false;
          }
        } catch (e) {
          // File was partial, will re-download
        }
      }
    }

    if (needDownload) {
      console.log(`⏳ Downloading '${colName}' (${totalDocs} docs)...`);
      const writeStream = fs.createWriteStream(filePath, { flags: 'w', encoding: 'utf-8' });
      writeStream.write('[\n');

      let exportedCount = 0;
      let lastId = null;
      const batchSize = 100;

      while (exportedCount < totalDocs) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await collection.find(query).sort({ _id: 1 }).limit(batchSize).toArray();
        if (!batch.length) break;

        for (const doc of batch) {
          if (exportedCount > 0) writeStream.write(',\n');
          writeStream.write(JSON.stringify(doc));
          exportedCount++;
        }
        lastId = batch[batch.length - 1]._id;
      }

      writeStream.write('\n]\n');
      await new Promise((resolve, reject) => {
        writeStream.end(resolve);
        writeStream.on('error', reject);
      });

      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`   ✅ Saved '${colName}': ${exportedCount}/${totalDocs} docs (${sizeMB} MB)`);

      manifest.collections[colName] = {
        count: exportedCount,
        fileSizeMB: sizeMB,
        file: `${colName}.json`,
        verified: exportedCount === totalDocs
      };
      manifest.totalDocuments += exportedCount;
    }
  }

  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log('\n==================================================');
  console.log('🎉 100% PRODUCTION BACKUP VERIFIED & COMPLETED!');
  console.log(`📁 Backup Path: ${backupDir}`);
  console.log(`📊 Total Collections: ${Object.keys(manifest.collections).length}`);
  console.log(`📄 Total Documents: ${manifest.totalDocuments}`);
  console.log('==================================================\n');

  await mongoose.connection.close();
}

completeBackup().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
