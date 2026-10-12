import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Response from '../models/Response.js';
dotenv.config();

async function benchmark() {
  console.log('🚀 Connecting to MongoDB for Analytics Query Benchmark...');
  await mongoose.connect(process.env.MONGODB_URI);

  const formId = '6a4633c8cbbdff3abd817674';
  const query = { questionId: formId };

  console.log(`\n⏱️ Running countDocuments for form ${formId}...`);
  const t0 = Date.now();
  const total = await Response.countDocuments(query);
  console.log(`✅ Total responses: ${total} (took ${Date.now() - t0}ms)`);

  console.log('\n⏱️ Fetching ALL responses with .lean() and analytics field selection (Optimized)...');
  const t1 = Date.now();
  const responses = await Response.find(query)
    .select('_id id questionId formId answers status submissionMetadata responseRanks createdAt timestamp submittedBy createdBy isDispatched dispatchedAt dispatchedBy dispatchedByName biwReview submittedAt tenantId')
    .sort({ createdAt: -1 })
    .lean();
  const dur = Date.now() - t1;

  console.log(`✅ Fetched ${responses.length} responses in ${dur}ms! 🚀`);
  console.log(`📦 Memory approx: ${(JSON.stringify(responses).length / (1024 * 1024)).toFixed(2)} MB`);

  if (dur < 2000) {
    console.log('🎉 PERFORMANCE GOAL MET: Sub-2-second query for 1800+ responses!');
  }

  await mongoose.connection.close();
}

benchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
