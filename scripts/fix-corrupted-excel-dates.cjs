const mongoose = require('mongoose');
require('dotenv').config();

async function fixDatabase(uri, label) {
  console.log(`\n==================================================`);
  console.log(`Checking and repairing database: ${label}`);
  console.log(`==================================================`);
  
  const conn = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 30000
  }).asPromise();

  // Find all responses with createdAt > year 3000
  const responses = await conn.db.collection('responses').find({
    createdAt: { $gt: new Date('3000-01-01') }
  }).toArray();

  console.log(`Found ${responses.length} responses with corrupted date in ${label}`);

  let updatedCount = 0;
  for (const r of responses) {
    const rawDate = new Date(r.createdAt);
    const yr = rawDate.getFullYear();
    if (yr >= 30000 && yr <= 100000) {
      // Excel epoch conversion: (serial - 25569) * 86400 * 1000
      const correctedUtcMs = (yr - 25569) * 86400 * 1000;
      const correctedDate = new Date(correctedUtcMs);

      await conn.db.collection('responses').updateOne(
        { _id: r._id },
        {
          $set: {
            createdAt: correctedDate,
            updatedAt: new Date()
          }
        }
      );
      updatedCount++;
    }
  }

  console.log(`✅ Successfully corrected ${updatedCount} responses in ${label}`);
  await conn.close();
}

async function run() {
  try {
    // 1. Fix New Dev Database
    if (process.env.MONGODB_URI) {
      await fixDatabase(process.env.MONGODB_URI, 'New Working DB (3wheelertvs_dev)');
    }

    // 2. Fix Old Prod Database if accessible
    const oldUri = process.env.OLD_PROD_URI || 'mongodb+srv://focushub360db:Priya%40123@focusforms.8im0otd.mongodb.net/3wheelertvs?retryWrites=true&w=majority';
    try {
      await fixDatabase(oldUri, 'Old Production DB (3wheelertvs)');
    } catch (e) {
      console.warn(`Could not update old prod: ${e.message}`);
    }

    console.log('\n🎉 Date correction completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

run();
