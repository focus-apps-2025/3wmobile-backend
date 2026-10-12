import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const rCol = db.collection('responses');
  const formsCol = db.collection('forms');
  
  const forms = await formsCol.find({ title: /paint/i }).toArray();
  for (const f of forms) {
    console.log('\n--- FORM:', f.title, 'id:', f.id, '_id:', f._id);
    const countTotal = await rCol.countDocuments({ questionId: f.id });
    const countSep = await rCol.countDocuments({
      questionId: f.id,
      createdAt: {
        $gte: new Date('2026-09-01T00:00:00.000Z'),
        $lte: new Date('2026-09-30T23:59:59.999Z')
      }
    });
    const countSep1to12 = await rCol.countDocuments({
      questionId: f.id,
      createdAt: {
        $gte: new Date('2026-09-01T00:00:00.000Z'),
        $lte: new Date('2026-09-12T23:59:59.999Z')
      }
    });
    console.log(`Total: ${countTotal}, Sep Total: ${countSep}, Sep 1-12: ${countSep1to12}`);

    const sample1to12 = await rCol.findOne({
      questionId: f.id,
      createdAt: {
        $gte: new Date('2026-09-01T00:00:00.000Z'),
        $lte: new Date('2026-09-12T23:59:59.999Z')
      }
    });
    if (sample1to12) {
      console.log('Sample 1-12 createdAt:', sample1to12.createdAt);
      console.log('Sample 1-12 timestamp:', sample1to12.timestamp);
      console.log('Sample 1-12 submittedAt:', sample1to12.submittedAt);
      console.log('Sample 1-12 submittedBy:', sample1to12.submittedBy);
      console.log('Sample 1-12 batchId:', sample1to12.batchId);
    }
  }
  process.exit(0);
}

run().catch(console.error);
