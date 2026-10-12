import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const fixIndexes = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected');

    const collection = mongoose.connection.collection('analyticsinvites');
    
    console.log('🔍 Checking indexes...');
    const indexes = await collection.indexes();
    console.log('Existing indexes:', JSON.stringify(indexes, null, 2));

    const indexesToDrop = ['formId_1_email_1', 'formId_1_phone_1'];
    
    for (const indexName of indexesToDrop) {
      try {
        console.log(`🗑️ Dropping index: ${indexName}...`);
        await collection.dropIndex(indexName);
        console.log(`✅ Dropped ${indexName}`);
      } catch (err) {
        if (err.codeName === 'IndexNotFound') {
          console.log(`ℹ️ Index ${indexName} not found, skipping.`);
        } else {
          console.error(`❌ Error dropping ${indexName}:`, err.message);
        }
      }
    }

    console.log('\n🎉 Index fix completed!');
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

fixIndexes();
