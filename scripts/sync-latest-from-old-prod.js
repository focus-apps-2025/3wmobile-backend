import mongoose from 'mongoose';
import dns from 'dns';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const OLD_PROD_URI = process.env.OLD_PROD_URI || 'mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority';
const NEW_DEV_URI = process.env.MONGODB_URI || 'mongodb+srv://focusengg123_db_user:XGm7JcV29XOBLOyz@cluster0.drsohth.mongodb.net/3wheelertvs_dev?retryWrites=true&w=majority';

async function connectWithRetry(uri, name, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connecting to ${name} (attempt ${attempt})...`);
      const conn = await mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 120000,
        connectTimeoutMS: 30000,
      }).asPromise();
      console.log(`✅ Connected to ${name}`);
      return conn;
    } catch (err) {
      console.warn(`⚠️ Connection to ${name} failed: ${err.message}. Retrying in 3s...`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function syncLatestFromOldProd() {
  console.log('===============================================================');
  console.log('🚀 ULTRA-FAST DELTA SYNC: OLD PROD DB -> NEW WORKING DB');
  console.log('===============================================================');
  console.log(`📡 Old Production DB: ${OLD_PROD_URI.replace(/:([^:@]+)@/, ':****@')}`);
  console.log(`📡 New Working DB:    ${NEW_DEV_URI.replace(/:([^:@]+)@/, ':****@')}\n`);

  const startTime = Date.now();
  let oldConn = null;
  let newConn = null;

  try {
    oldConn = await connectWithRetry(OLD_PROD_URI, 'Old Production DB (3wheelertvs)');
    newConn = await connectWithRetry(NEW_DEV_URI, 'New Working DB (3wheelertvs_dev)');

    const oldDb = oldConn.db;
    const newDb = newConn.db;

    const targetCollections = [
      'forms',
      'users',
      'responses',
      'formsessions',
      'reviews',
      'chatmessages'
    ];

    const summary = {};

    for (const colName of targetCollections) {
      const oldCol = oldDb.collection(colName);
      const newCol = newDb.collection(colName);

      console.log(`\n📦 Checking differences for: '${colName}'...`);
      const oldIds = await oldCol.distinct('_id');
      const newIds = await newCol.distinct('_id');

      const newIdSet = new Set(newIds.map(id => id.toString()));
      const missingIds = oldIds.filter(id => !newIdSet.has(id.toString()));

      console.log(`   Old total: ${oldIds.length} | New total: ${newIds.length}`);
      console.log(`   ⚡ Missing documents to transfer into New DB: ${missingIds.length}`);

      let insertedCount = 0;

      if (missingIds.length > 0) {
        const batchSize = 200;
        for (let i = 0; i < missingIds.length; i += batchSize) {
          const batchIds = missingIds.slice(i, i + batchSize);
          
          let docsToInsert = [];
          let retries = 3;
          while (retries > 0) {
            try {
              docsToInsert = await oldCol.find({ _id: { $in: batchIds } }).toArray();
              break;
            } catch (fetchErr) {
              retries--;
              console.warn(`   ⚠️ Fetch retry on '${colName}': ${fetchErr.message}`);
              if (retries === 0) throw fetchErr;
              await new Promise(r => setTimeout(r, 2000));
            }
          }

          if (docsToInsert.length > 0) {
            let writeRetries = 3;
            while (writeRetries > 0) {
              try {
                await newCol.insertMany(docsToInsert, { ordered: false });
                insertedCount += docsToInsert.length;
                break;
              } catch (writeErr) {
                writeRetries--;
                console.warn(`   ⚠️ Write retry on '${colName}': ${writeErr.message}`);
                if (writeRetries === 0) throw writeErr;
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          }

          process.stdout.write(`   ↳ Transferred ${insertedCount}/${missingIds.length} missing docs into New DB...\r`);
        }
      }

      const newTotalAfter = await newCol.countDocuments({});
      console.log(`\n   ✅ '${colName}': Sync Complete! Added: ${insertedCount} docs | Total in New DB now: ${newTotalAfter}`);

      summary[colName] = {
        oldTotal: oldIds.length,
        newTotalBefore: newIds.length,
        newlyAdded: insertedCount,
        newTotalAfter: newTotalAfter
      };
    }

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n===============================================================');
    console.log(`🎉 ALL LATEST DATA SYNCHRONIZED SUCCESSFULLY IN ${durationSeconds}s!`);
    console.log('===============================================================');
    console.table(summary);

  } catch (error) {
    console.error('❌ Sync Failed:', error);
  } finally {
    if (oldConn) await oldConn.close();
    if (newConn) await newConn.close();
    console.log('🔒 Database connections closed');
  }
}

syncLatestFromOldProd();
