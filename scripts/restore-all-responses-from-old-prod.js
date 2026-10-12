import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const OLD_PROD_URI = process.env.OLD_PROD_URI || process.env.PROD_MONGO_URI || 'mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority';
const RUNNING_DEV_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function connectWithRetry(uri, name, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connecting to ${name} (attempt ${attempt})...`);
      const conn = await mongoose.createConnection(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 120000,
        connectTimeoutMS: 30000,
        retryWrites: true,
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

async function restoreAllData() {
  console.log('🚀 Restoring all original documents from Old Production DB into Running DB...');
  console.log(`📡 Old Production DB: ${OLD_PROD_URI.replace(/:([^:@]+)@/, ':****@')}`);
  console.log(`📡 Current Running DB: ${RUNNING_DEV_URI.replace(/:([^:@]+)@/, ':****@')}\n`);

  const startTime = Date.now();
  let oldProdConn = null;
  let runningDevConn = null;

  try {
    oldProdConn = await connectWithRetry(OLD_PROD_URI, 'Old Production DB (3wheelertvs)');
    runningDevConn = await connectWithRetry(RUNNING_DEV_URI, 'Current Running DB (3wheelertvs_dev)');

    const oldDb = oldProdConn.db;
    const devDb = runningDevConn.db;

    // Specifically restore responses and formsessions and reviews
    const targetCollections = ['responses', 'formsessions', 'reviews', 'chatmessages', 'users', 'tenants'];

    for (const colName of targetCollections) {
      const oldCollection = oldDb.collection(colName);
      const devCollection = devDb.collection(colName);

      const totalCount = await oldCollection.countDocuments({});
      console.log(`\n🔄 Restoring '${colName}': Found ${totalCount} total documents in Old Production DB...`);

      const batchSize = 100;
      let lastId = null;
      let totalSynced = 0;
      let hasMore = true;

      while (hasMore) {
        let chunk = [];
        let retries = 3;

        while (retries > 0) {
          try {
            const query = lastId ? { _id: { $gt: lastId } } : {};
            chunk = await oldCollection.find(query).sort({ _id: 1 }).limit(batchSize).toArray();
            break;
          } catch (fetchErr) {
            retries--;
            console.warn(`\n⚠️ Fetch error in '${colName}': ${fetchErr.message}. Retries left: ${retries}`);
            if (retries === 0) throw fetchErr;
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!chunk || chunk.length === 0) {
          hasMore = false;
          break;
        }

        const writeOps = chunk.map(doc => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          }
        }));

        let writeRetries = 3;
        while (writeRetries > 0) {
          try {
            await devCollection.bulkWrite(writeOps, { ordered: false });
            break;
          } catch (writeErr) {
            writeRetries--;
            console.warn(`\n⚠️ Write error in '${colName}': ${writeErr.message}. Retries left: ${writeRetries}`);
            if (writeRetries === 0) throw writeErr;
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        totalSynced += chunk.length;
        lastId = chunk[chunk.length - 1]._id;
        process.stdout.write(`   ↳ Synced ${totalSynced}/${totalCount} docs...\r`);

        if (chunk.length < batchSize) {
          hasMore = false;
        }
      }

      console.log(`   ✅ '${colName}': Successfully restored ${totalSynced} documents!`);
    }

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 Full DB Revert & Restoration Complete in ${durationSeconds}s!`);

  } catch (error) {
    console.error('❌ Restoration Failed:', error);
  } finally {
    if (oldProdConn) await oldProdConn.close();
    if (runningDevConn) await runningDevConn.close();
    console.log('🔒 Database connections closed');
  }
}

restoreAllData();
