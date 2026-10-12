import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const activityLogsCollection = db.collection('activitylogs');

    console.log('\n🔍 Fetching recent activity logs for user modifications...');
    const logs = await activityLogsCollection.find({
      $or: [
        { resourceId: '6a210f8315e25bd56fdcabe6' },
        { resourceType: 'user' },
        { action: { $regex: 'user', $options: 'i' } }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

    console.log(`Found ${logs.length} logs:`);
    for (const log of logs) {
      console.log(`- Date: ${log.createdAt || log.timestamp}`);
      console.log(`  Action: ${log.action}`);
      console.log(`  User: ${log.userId}`);
      console.log(`  Resource: ${log.resourceType} (${log.resourceId})`);
      console.log(`  Metadata:`, JSON.stringify(log.metadata, null, 2));
      console.log('--------------------------------------------');
    }
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  }
}

run();
