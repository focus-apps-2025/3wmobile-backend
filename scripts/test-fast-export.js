const uri = process.env.PROD_MONGODB_URI || process.env.MONGO_URI;

async function testFastExport() {
  if (!uri) {
    console.error("❌ Error: MONGO_URI environment variable is required.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const col = db.collection('formsessions');
  const total = await col.countDocuments();
  console.log('Total formsessions:', total);

  const start = Date.now();
  let count = 0;
  let lastId = null;

  while (true) {
    const query = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await col.find(query).sort({ _id: 1 }).limit(500).toArray();
    if (!batch.length) break;

    count += batch.length;
    lastId = batch[batch.length - 1]._id;
    console.log(`Fetched ${count}/${total} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  console.log(`🎉 Done in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  await mongoose.connection.close();
}

testFastExport();
