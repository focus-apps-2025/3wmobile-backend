import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI).then(async () => {
  const conn = mongoose.connection;
  const collection = conn.collection('responses');
  const futureEntries = await collection.find({ createdAt: { $gte: new Date('2027-01-01') } }).toArray();
  
  console.log("Future entries found:", futureEntries.length);
  futureEntries.forEach(entry => {
    console.log(`- SubmittedBy: ${entry.submittedBy}, Chassis: ${entry.chassisNumber}, Date: ${entry.createdAt}, Status: ${entry.status}`);
  });
  process.exit();
}).catch(console.error);
