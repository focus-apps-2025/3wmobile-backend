import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const users = await User.find({});
    console.log(`\n👤 ALL USERS IN DB (Total: ${users.length}):`);
    for (const u of users) {
      console.log(`- ID: ${u._id}`);
      console.log(`  Email: ${u.email}`);
      console.log(`  Username: ${u.username}`);
      console.log(`  Role: ${u.role}`);
      console.log(`  isActive: ${u.isActive}`);
      console.log(`  TenantId: ${u.tenantId}`);
      console.log('------------------------');
    }
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  }
}

run();
