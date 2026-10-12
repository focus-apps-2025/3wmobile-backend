import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const RUNNING_DEV_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function checkLatestDate() {
  try {
    const conn = await mongoose.connect(RUNNING_DEV_URI);
    const db = conn.connection.db;
    
    const latestResponse = await db.collection('responses').find({}).sort({ createdAt: -1 }).limit(1).toArray();
    
    if (latestResponse.length > 0) {
      console.log('Latest Response Date in DB:', latestResponse[0].createdAt || latestResponse[0].timestamp);
    } else {
      console.log('No responses found.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    mongoose.disconnect();
  }
}

checkLatestDate();
