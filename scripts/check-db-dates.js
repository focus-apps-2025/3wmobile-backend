import mongoose from 'mongoose';
import dns from 'dns';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {}

const NEW_DB_URI = 'mongodb+srv://focusengg123_db_user:XGm7JcV29XOBLOyz@cluster0.drsohth.mongodb.net/3wheelertvs_dev?retryWrites=true&w=majority';
const OLD_DB_URI = 'mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority';

async function inspectDb(uri, label) {
  console.log('\n=============================================');
  console.log(`=== ${label} ===`);
  console.log('=============================================');
  try {
    const conn = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
    }).asPromise();
    const db = conn.db;
    const collections = await db.listCollections().toArray();
    console.log('Total collections in DB:', collections.length);

    for (const col of ['responses', 'formsessions', 'bulkimporthistories', 'forms', 'users', 'reviews', 'attendances']) {
      if (collections.some(c => c.name === col)) {
        const collection = db.collection(col);
        const count = await collection.countDocuments();
        
        // Find newest document by createdAt
        const newestCreated = await collection.find({}).sort({ createdAt: -1 }).limit(1).toArray();
        const oldestCreated = await collection.find({}).sort({ createdAt: 1 }).limit(1).toArray();
        const newestUpdated = await collection.find({}).sort({ updatedAt: -1 }).limit(1).toArray();
        
        console.log(`\n📂 [${col}] (Total count: ${count})`);
        if (oldestCreated[0]) {
          const dt = oldestCreated[0].createdAt || oldestCreated[0].timestamp || oldestCreated[0]._id?.getTimestamp();
          console.log(`  - Oldest createdAt: ${dt}`);
        }
        if (newestCreated[0]) {
          const dt = newestCreated[0].createdAt || newestCreated[0].timestamp || newestCreated[0]._id?.getTimestamp();
          console.log(`  - Newest createdAt: ${dt}`);
        }
        if (newestUpdated[0]) {
          console.log(`  - Newest updatedAt: ${newestUpdated[0].updatedAt}`);
        }
        
        if (col === 'responses') {
          // Find newest valid response (< year 2030)
          const validDateFilter = { createdAt: { $gte: new Date('2020-01-01'), $lte: new Date('2030-01-01') } };
          const newestValid = await collection.find(validDateFilter).sort({ createdAt: -1 }).limit(10).toArray();
          console.log(`  - Total valid responses (between 2020 and 2030): ${await collection.countDocuments(validDateFilter)}`);
          if (newestValid[0]) {
            console.log(`  - REAL Newest valid createdAt: ${newestValid[0].createdAt}`);
          }
          console.log('  - Top 5 realistic newest responses:');
          newestValid.slice(0, 5).forEach((s, idx) => {
            console.log(`    #${idx + 1}: By: ${s.submittedBy || 'N/A'} | CreatedAt: ${s.createdAt} | FormId: ${s.formId} | Batch: ${s.batchId || 'N/A'}`);
          });

          // Check response dates by submittedAt
          const newestBySubmittedAt = await collection.find({ submittedAt: { $exists: true, $ne: null } }).sort({ submittedAt: -1 }).limit(1).toArray();
          if (newestBySubmittedAt[0]) {
            console.log(`  - Newest submittedAt: ${newestBySubmittedAt[0].submittedAt}`);
          }
          
          // Check by date field if exists
          const newestByDate = await collection.find({ date: { $exists: true, $ne: null } }).sort({ date: -1 }).limit(1).toArray();
          if (newestByDate[0]) {
            console.log(`  - Newest 'date' field: ${newestByDate[0].date}`);
          }

          // Top 5 newest responses details
          const sample = await collection.find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .project({ chassisNumber: 1, createdAt: 1, submittedAt: 1, updatedAt: 1, batchId: 1, submittedBy: 1 })
            .toArray();
          console.log('  - Top 5 newest response records:');
          sample.forEach((s, idx) => {
            console.log(`    #${idx + 1}: Chassis: ${s.chassisNumber} | Created: ${s.createdAt} | Submitted: ${s.submittedAt} | Updated: ${s.updatedAt} | Batch: ${s.batchId || 'none'} | By: ${s.submittedBy || 'N/A'}`);
          });
        }
      }
    }
    await conn.close();
  } catch (err) {
    console.error(`❌ Error connecting to ${label}:`, err.message);
  }
}

async function run() {
  await inspectDb(NEW_DB_URI, 'NEW DB (3wheelertvs_dev)');
  await inspectDb(OLD_DB_URI, 'OLD DB (3wheelertvs)');
  process.exit(0);
}

run();
