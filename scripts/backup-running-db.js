import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNNING_DEV_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function performBackup() {
  if (!RUNNING_DEV_URI) {
    console.error("❌ Error: MONGO_URI environment variable is required.");
    process.exit(1);
  }
  console.log('🚀 Starting Complete Backup of Current Running DB...');
  console.log(`📡 Connecting to: ${RUNNING_DEV_URI.replace(/:([^:@]+)@/, ':****@')}`);

  const startTime = Date.now();

  try {
    await mongoose.connect(RUNNING_DEV_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
    });
    console.log('✅ Connected to MongoDB Atlas (Running DB)');

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log(`📦 Found ${collections.length} collections\n`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'backups', `backup_running_dev_${timestamp}`);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const manifest = {
      database: '3wheelertvs_dev',
      timestamp: new Date().toISOString(),
      collections: {},
      totalDocuments: 0,
      status: 'IN_PROGRESS'
    };

    for (const col of collections) {
      const colName = col.name;
      if (colName.startsWith('system.')) continue;

      const collection = db.collection(colName);
      const totalDocs = await collection.countDocuments();
      console.log(`⏳ Backing up '${colName}' (${totalDocs} documents)...`);

      const filePath = path.join(backupDir, `${colName}.json`);
      const writeStream = fs.createWriteStream(filePath, { flags: 'w', encoding: 'utf-8' });

      writeStream.write('[\n');

      let exportedCount = 0;
      let lastId = null;
      const batchSize = 500;

      while (exportedCount < totalDocs) {
        let retryCount = 0;
        let batch = null;

        while (retryCount < 5) {
          try {
            const query = lastId ? { _id: { $gt: lastId } } : {};
            batch = await collection.find(query).sort({ _id: 1 }).limit(batchSize).toArray();
            break;
          } catch (err) {
            retryCount++;
            console.log(`\n⚠️ Retry ${retryCount}/5 for '${colName}' at doc ${exportedCount}: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!batch || batch.length === 0) break;

        for (const doc of batch) {
          if (exportedCount > 0) {
            writeStream.write(',\n');
          }
          writeStream.write(JSON.stringify(doc));
          exportedCount++;
        }

        lastId = batch[batch.length - 1]._id;
        process.stdout.write(`   ↳ Exported ${exportedCount}/${totalDocs} docs (${totalDocs > 0 ? Math.round((exportedCount / totalDocs) * 100) : 100}%)\r`);
      }

      writeStream.write('\n]\n');
      await new Promise((resolve, reject) => {
        writeStream.end(resolve);
        writeStream.on('error', reject);
      });

      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`   ✅ Saved '${colName}': ${exportedCount} docs (${sizeMB} MB)`);

      manifest.collections[colName] = {
        count: exportedCount,
        fileSizeMB: sizeMB,
        file: `${colName}.json`
      };
      manifest.totalDocuments += exportedCount;
    }

    manifest.status = 'COMPLETED';
    manifest.durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    const manifestPath = path.join(backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    console.log('\n========================================');
    console.log('🎉 RUNNING DATABASE BACKUP COMPLETE 100%!');
    console.log(`📁 Directory: ${backupDir}`);
    console.log(`📊 Collections: ${Object.keys(manifest.collections).length}`);
    console.log(`📄 Total Documents: ${manifest.totalDocuments}`);
    console.log(`⏱️ Duration: ${manifest.durationSeconds}s`);
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Backup Failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔒 Database connection closed');
  }
}

performBackup();
