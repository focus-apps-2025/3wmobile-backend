import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI;

async function ensureIndexes() {
  console.log('🚀 Connecting to MongoDB to build performance indexes...');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('📌 Creating indexes on `responses` collection...');
  const responses = db.collection('responses');
  
  await responses.createIndex({ questionId: 1, createdAt: -1 }, { background: true });
  await responses.createIndex({ questionId: 1, status: 1 }, { background: true });
  await responses.createIndex({ tenantId: 1, questionId: 1 }, { background: true });
  await responses.createIndex({ formId: 1, createdAt: -1 }, { background: true });
  await responses.createIndex({ createdBy: 1 }, { background: true });
  console.log('✅ `responses` indexes created successfully!');

  console.log('📌 Creating indexes on `formsessions` collection...');
  const formsessions = db.collection('formsessions');
  await formsessions.createIndex({ formId: 1, updatedAt: -1 }, { background: true });
  await formsessions.createIndex({ userId: 1 }, { background: true });
  console.log('✅ `formsessions` indexes created successfully!');

  console.log('📌 Creating indexes on `reviews` collection...');
  const reviews = db.collection('reviews');
  await reviews.createIndex({ responseId: 1, createdAt: -1 }, { background: true });
  console.log('✅ `reviews` indexes created successfully!');

  const indexes = await responses.indexes();
  console.log('\n📊 Active indexes on `responses`:');
  indexes.forEach(idx => console.log(` - ${JSON.stringify(idx.key)} (${idx.name})`));

  await mongoose.connection.close();
  console.log('\n🎉 All performance indexes verified and active!');
}

ensureIndexes().catch(err => {
  console.error('Error creating indexes:', err);
  process.exit(1);
});
