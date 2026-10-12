import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const rCol = db.collection('responses');
  const formsCol = db.collection('forms');
  
  const form = await formsCol.findOne({ title: /LB Bef Paint/i });
  const ids = [form.id, form._id.toString()];

  const total = await rCol.countDocuments({ questionId: { $in: ids } });
  const sepTotal = await rCol.countDocuments({
    questionId: { $in: ids },
    createdAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-30T23:59:59.999Z') }
  });
  const sep1to12 = await rCol.countDocuments({
    questionId: { $in: ids },
    createdAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-12T23:59:59.999Z') }
  });
  const sep13to30 = await rCol.countDocuments({
    questionId: { $in: ids },
    createdAt: { $gte: new Date('2026-09-13T00:00:00.000Z'), $lte: new Date('2026-09-30T23:59:59.999Z') }
  });

  console.log('LB Bef Paint:');
  console.log(`Total: ${total}, Sep Total: ${sepTotal}, Sep 1-12: ${sep1to12}, Sep 13-30: ${sep13to30}`);

  // LB Aft Paint
  const formAft = await formsCol.findOne({ title: /LB Aft Paint/i });
  const idsAft = [formAft.id, formAft._id.toString()];
  const totalAft = await rCol.countDocuments({ questionId: { $in: idsAft } });
  const sepTotalAft = await rCol.countDocuments({
    questionId: { $in: idsAft },
    createdAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-30T23:59:59.999Z') }
  });
  const sep1to12Aft = await rCol.countDocuments({
    questionId: { $in: idsAft },
    createdAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-12T23:59:59.999Z') }
  });
  const sep13to30Aft = await rCol.countDocuments({
    questionId: { $in: idsAft },
    createdAt: { $gte: new Date('2026-09-13T00:00:00.000Z'), $lte: new Date('2026-09-30T23:59:59.999Z') }
  });
  console.log('\nLB Aft Paint:');
  console.log(`Total: ${totalAft}, Sep Total: ${sepTotalAft}, Sep 1-12: ${sep1to12Aft}, Sep 13-30: ${sep13to30Aft}`);

  process.exit(0);
}

run().catch(console.error);
