import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
// add tenant to all users except superadmin and  inspector 
dotenv.config();

async function checkUserTenant() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get all users
    const users = await User.find({})
      .select('username email role tenantId firstName lastName')
      .populate('tenantId', 'name slug');

    console.log('\n📋 User List with Tenant Information:\n');
    console.log('='.repeat(80));

    users.forEach((user, index) => {
      console.log(`\n${index + 1}. ${user.firstName} ${user.lastName}`);
      console.log(`   Username: ${user.username}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   Role: ${user.role}`);

      if (user.tenantId) {
        console.log(`   Tenant: ${user.tenantId.name} (${user.tenantId.slug})`);
        console.log(`   TenantId: ${user.tenantId._id}`);
      } else {
        console.log(`   Tenant: ⚠️  NO TENANT ASSIGNED`);
        if (user.role !== 'superadmin') {
          console.log(`   ⚠️  WARNING: This user needs a tenantId to create forms!`);
        }
      }
    });

    console.log('\n' + '='.repeat(80));
    console.log('\n✅ Check complete!');

    // Summary
    const usersWithoutTenant = users.filter(u => !u.tenantId && u.role !== 'superadmin');
    if (usersWithoutTenant.length > 0) {
      console.log(`\n⚠️  WARNING: ${usersWithoutTenant.length} user(s) without tenantId found!`);
      console.log('These users will not be able to create forms.');
    }
    // add tenant to all users
    //const usersWithoutTenant = users.filter(u => !u.tenantId);
    //const tenant = await Tenant.findOne({ slug: 'focus' });
    //usersWithoutTenant.forEach(async (user) => {
    //  user.tenantId = tenant._id;
    //  await user.save();
    //});
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

checkUserTenant();