import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';

dotenv.config();

async function check() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const users = await User.find({ tenantId: '6a13247a5a444320345526f5' });
    console.log('\n👤 ALL USERS IN TENANT "SRIMATHI TESTING":');
    for (const u of users) {
      console.log(`- ID: ${u._id}`);
      console.log(`  Email: ${u.email}`);
      console.log(`  Username: ${u.username}`);
      console.log(`  Role: ${u.role}`);
      console.log(`  isActive: ${u.isActive}`);
      console.log('------------------------');
    }

    const tenant = await Tenant.findById('6a13247a5a444320345526f5');
    if (tenant) {
      console.log('\n🏢 TENANT DETAILS:');
      console.log(`  Name: ${tenant.name}`);
      console.log(`  isActive: ${tenant.isActive}`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

check();
