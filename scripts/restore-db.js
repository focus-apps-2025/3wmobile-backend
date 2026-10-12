import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not defined in .env file.");
  process.exit(1);
}

const CHUNK_SIZE = 500;

const restoreDatabase = async () => {
  try {
    console.log(`Connecting to new database: ${MONGODB_URI.split('@')[1]}`);
    await mongoose.connect(MONGODB_URI);
    console.log("Connected successfully.");

    const db = mongoose.connection.db;

    const backupsDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
      console.error("No backups directory found.");
      return;
    }

    const backupFolders = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('db-backup-'))
      .sort()
      .reverse();

    if (backupFolders.length === 0) {
      console.error("No backup folders found.");
      return;
    }

    const latestBackupDir = path.join(backupsDir, backupFolders[0]);
    console.log(`Using backup from: ${latestBackupDir}`);

    const files = fs.readdirSync(latestBackupDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const collectionName = file.replace('.json', '');
      const filePath = path.join(latestBackupDir, file);
      
      console.log(`\nRestoring collection: ${collectionName}...`);
      
      // Read file
      const rawData = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(rawData);

      if (!Array.isArray(data) || data.length === 0) {
        console.log(`  Skipping ${collectionName} (Empty)`);
        continue;
      }

      // Convert $oid and $date if needed (though mongodump uses extended JSON, we used raw mongoose output which has regular objects, 
      // but _id might be strings. We'll let MongoDB native driver handle it or map them to ObjectId)
      const formattedData = data.map(doc => {
        if (doc._id && typeof doc._id === 'string') {
           doc._id = new mongoose.Types.ObjectId(doc._id);
        }
        return doc;
      });

      console.log(`  Found ${formattedData.length} documents. Inserting in chunks of ${CHUNK_SIZE}...`);
      
      const collection = db.collection(collectionName);
      
      // Clear existing collection first just in case
      await collection.deleteMany({});

      let insertedCount = 0;
      for (let i = 0; i < formattedData.length; i += CHUNK_SIZE) {
        const chunk = formattedData.slice(i, i + CHUNK_SIZE);
        await collection.insertMany(chunk, { ordered: false });
        insertedCount += chunk.length;
        process.stdout.write(`\r  Progress: ${insertedCount} / ${formattedData.length}`);
      }
      console.log(`\n  Successfully restored ${collectionName}.`);
    }

    console.log("\n✅ All collections restored successfully!");
  } catch (error) {
    console.error("\n❌ Restore failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
  }
};

restoreDatabase();
