import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const rCol = db.collection('responses');
  const formsCol = db.collection('forms');
  const usersCol = db.collection('users');

  const form = await formsCol.findOne({ title: /LB Bef Paint/i });
  console.log('Form tenantId:', form.tenantId);

  // Check tenants of responses in Sep 1-12 vs Sep 13-30
  const sep1to12Responses = await rCol.find({
    questionId: { $in: [form.id, form._id.toString()] },
    createdAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-12T23:59:59.999Z') }
  }).project({ tenantId: 1, submittedBy: 1, createdAt: 1, batchId: 1 }).toArray();

  const sep13to30Responses = await rCol.find({
    questionId: { $in: [form.id, form._id.toString()] },
    createdAt: { $gte: new Date('2026-09-13T00:00:00.000Z'), $lte: new Date('2026-09-30T23:59:59.999Z') }
  }).project({ tenantId: 1, submittedBy: 1, createdAt: 1, batchId: 1 }).toArray();

  const tenants1to12 = new Set(sep1to12Responses.map(r => String(r.tenantId)));
  const tenants13to30 = new Set(sep13to30Responses.map(r => String(r.tenantId)));

  console.log('Tenants in Sep 1-12:', Array.from(tenants1to12));
  console.log('Tenants in Sep 13-30:', Array.from(tenants13to30));
  
  // Check users who might be querying this
  const users = await usersCol.find({}).project({ username: 1, email: 1, role: 1, tenantId: 1 }).toArray();
  console.log('Users sample:');
  users.slice(0, 10).forEach(u => console.log(u.username, u.role, 'tenant:', u.tenantId));

  process.exit(0);
}

run().catch(console.error);
