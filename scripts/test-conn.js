const uri = process.env.PROD_MONGODB_URI || process.env.MONGO_URI;

async function test() {
  if (!uri) {
    console.error("❌ Error: MONGO_URI environment variable is required.");
    process.exit(1);
  }
  try {
    console.log('Connecting with standard options...');
    await mongoose.connect(uri);
    console.log('✅ Connection Successful!');
    const db = mongoose.connection.db;
    const cols = await db.listCollections().toArray();
    console.log('Collections:', cols.map(c => c.name));
    await mongoose.connection.close();
  } catch (err) {
    console.error('Connection Error:', err.message);
  }
}

test();
