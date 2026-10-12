import mongoose from 'mongoose';
import dns from 'dns';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {}

const NEW_DB_URI = 'mongodb+srv://focusengg123_db_user:XGm7JcV29XOBLOyz@cluster0.drsohth.mongodb.net/3wheelertvs_dev?retryWrites=true&w=majority';
const OLD_DB_URI = 'mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority';

async function checkDiff() {
  console.log('Connecting to both DBs...');
  const connNew = await mongoose.createConnection(NEW_DB_URI).asPromise();
  const connOld = await mongoose.createConnection(OLD_DB_URI).asPromise();

  const newDb = connNew.db;
  const oldDb = connOld.db;

  for (const colName of ['responses', 'formsessions', 'reviews', 'users', 'tenants', 'chatmessages']) {
    const oldCol = oldDb.collection(colName);
    const newCol = newDb.collection(colName);

    const oldIds = await oldCol.distinct('_id');
    const newIds = await newCol.distinct('_id');

    const newIdSet = new Set(newIds.map(id => id.toString()));
    const oldIdSet = new Set(oldIds.map(id => id.toString()));

    const missingInNew = oldIds.filter(id => !newIdSet.has(id.toString()));
    const onlyInNew = newIds.filter(id => !oldIdSet.has(id.toString()));

    console.log(`[${colName}] Old total: ${oldIds.length} | New total: ${newIds.length}`);
    console.log(`  -> Documents in Old that are MISSING in New: ${missingInNew.length}`);
    console.log(`  -> Documents existing ONLY in New: ${onlyInNew.length}\n`);

    if (colName === 'responses') {
      const newBatchCount = await newCol.countDocuments({ batchId: { $exists: true, $ne: null } });
      const oldBatchCount = await oldCol.countDocuments({ batchId: { $exists: true, $ne: null } });
      console.log(`  🔍 Responses with batchId: New DB = ${newBatchCount} | Old DB = ${oldBatchCount}`);
      
      // Check if any overlapping documents have newer updatedAt in Old DB
      const overlapSample = await oldCol.find({ _id: { $in: newIds.slice(0, 100) } }).toArray();
      console.log(`  Sample 100 overlapping responses checked.`);
    }
  }

  await connNew.close();
  await connOld.close();
  process.exit(0);
}

checkDiff();
