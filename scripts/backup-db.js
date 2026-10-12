import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not defined in .env file.");
  process.exit(1);
}

const backupDatabase = async () => {
  try {
    console.log("Connecting to database...");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected successfully.");

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    // Create backup directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '../backups', `db-backup-${timestamp}`);
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    console.log(`Starting backup of ${collections.length} collections into: ${backupDir}`);

    for (const collection of collections) {
      const collectionName = collection.name;
      console.log(`Backing up collection: ${collectionName}...`);
      
      const data = await db.collection(collectionName).find({}).toArray();
      
      const filePath = path.join(backupDir, `${collectionName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`  Saved ${data.length} documents to ${collectionName}.json`);
    }

    console.log("Backup completed successfully!");
  } catch (error) {
    console.error("Backup failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
  }
};

backupDatabase();
