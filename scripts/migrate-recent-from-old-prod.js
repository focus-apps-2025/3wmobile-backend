const OLD_PROD_URI = process.env.OLD_PROD_URI || process.env.PROD_MONGO_URI;
const RUNNING_DEV_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

// August 17, 2026 00:00:00 UTC
const CUTOFF_DATE = new Date('2026-08-17T00:00:00.000Z');
// Generate ObjectId representing 2026-08-17 00:00:00 UTC timestamp
const CUTOFF_OBJECT_ID = new mongoose.Types.ObjectId(
  Math.floor(CUTOFF_DATE.getTime() / 1000).toString(16) + '0000000000000000'
);

async function migrateRecentData() {
  if (!OLD_PROD_URI || !RUNNING_DEV_URI) {
    console.error("❌ Error: Both OLD_PROD_URI and MONGO_URI environment variables are required.");
    process.exit(1);
  }
  console.log('🚀 Starting Data Migration from Old Production DB to Running DB...');
  console.log(`📅 Cutoff Date: ${CUTOFF_DATE.toISOString()} (After Aug 17, 2026)`);
  console.log(`📡 Old Production DB: ${OLD_PROD_URI.replace(/:([^:@]+)@/, ':****@')}`);
  console.log(`📡 Current Running DB: ${RUNNING_DEV_URI.replace(/:([^:@]+)@/, ':****@')}\n`);

  const startTime = Date.now();
  let oldProdConn = null;
  let runningDevConn = null;

  try {
    console.log('Connecting to Old Production DB...');
    oldProdConn = await mongoose.createConnection(OLD_PROD_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
    }).asPromise();
    console.log('✅ Connected to Old Production DB (3wheelertvs)');

    console.log('Connecting to Current Running DB...');
    runningDevConn = await mongoose.createConnection(RUNNING_DEV_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
    }).asPromise();
    console.log('✅ Connected to Current Running DB (3wheelertvs_dev)\n');

    const oldDb = oldProdConn.db;
    const devDb = runningDevConn.db;

    const collections = await oldDb.listCollections().toArray();
    console.log(`📦 Found ${collections.length} collections in Old Production DB\n`);

    const summary = {};
    let totalMigratedAll = 0;

    for (const col of collections) {
      const colName = col.name;
      if (colName.startsWith('system.')) continue;

      const oldCollection = oldDb.collection(colName);
      const devCollection = devDb.collection(colName);

      // Build query matching any doc created/updated on or after Aug 17, 2026
      const query = {
        $or: [
          { createdAt: { $gte: CUTOFF_DATE } },
          { updatedAt: { $gte: CUTOFF_DATE } },
          { timestamp: { $gte: CUTOFF_DATE } },
          { submittedAt: { $gte: CUTOFF_DATE } },
          { _id: { $gte: CUTOFF_OBJECT_ID } },
        ]
      };

      const matchingCount = await oldCollection.countDocuments(query);

      if (matchingCount === 0) {
        console.log(`⏩ '${colName}': 0 documents after Aug 17, 2026 (Skipped)`);
        summary[colName] = { matched: 0, upserted: 0 };
        continue;
      }

      console.log(`🔄 Processing '${colName}': Found ${matchingCount} documents after Aug 17, 2026...`);

      const cursor = oldCollection.find(query);
      let batch = [];
      let upsertedCount = 0;
      const batchSize = 250;

      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        batch.push({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          }
        });

        if (batch.length >= batchSize) {
          const result = await devCollection.bulkWrite(batch, { ordered: false });
          upsertedCount += (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0);
          batch = [];
          process.stdout.write(`   ↳ Synced ${upsertedCount}/${matchingCount} docs...\r`);
        }
      }

      if (batch.length > 0) {
        const result = await devCollection.bulkWrite(batch, { ordered: false });
        upsertedCount += (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0);
      }

      console.log(`   ✅ '${colName}': Successfully synced ${matchingCount} documents into Running DB!`);
      summary[colName] = { matched: matchingCount, upserted: upsertedCount };
      totalMigratedAll += matchingCount;
    }

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n========================================');
    console.log('🎉 RECENT DATA EXTRACTION & MIGRATION COMPLETE!');
    console.log(`📅 Cutoff: After Aug 17, 2026`);
    console.log(`📄 Total Documents Processed: ${totalMigratedAll}`);
    console.log(`⏱️ Duration: ${durationSeconds}s`);
    console.log('----------------------------------------');
    console.log('Summary by Collection:');
    for (const [name, stats] of Object.entries(summary)) {
      if (stats.matched > 0) {
        console.log(` - ${name}: ${stats.matched} docs synced`);
      }
    }
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Migration Failed:', error);
    process.exit(1);
  } finally {
    if (oldProdConn) await oldProdConn.close();
    if (runningDevConn) await runningDevConn.close();
    console.log('🔒 Database connections closed');
  }
}

migrateRecentData();
