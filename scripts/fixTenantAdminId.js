import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Tenant from '../models/Tenant.js';

dotenv.config();

const fixCorruptedTenants = async () => {
  try {
    console.log('🔧 Starting tenant adminId fix...');
    
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB');

    const tenants = await Tenant.find({});
    console.log(`Found ${tenants.length} tenants`);

    let fixedCount = 0;

    for (const tenant of tenants) {
      if (Array.isArray(tenant.adminId) && tenant.adminId.length > 0) {
        console.log(`⚠️  Tenant "${tenant.name}" has array adminId: ${tenant.adminId}`);
        
        tenant.adminId = tenant.adminId[0];
        
        await tenant.save();
        fixedCount++;
        console.log(`✓ Fixed tenant "${tenant.name}" - set adminId to ${tenant.adminId}`);
      } else if (!tenant.adminId) {
        console.log(`⚠️  Tenant "${tenant.name}" has no adminId - consider deleting or reassigning`);
      }
    }

    console.log(`\n✅ Fixed ${fixedCount} tenants`);
    await mongoose.connection.close();
    console.log('Connection closed');
    
  } catch (error) {
    console.error('❌ Error fixing tenants:', error);
    process.exit(1);
  }
};

fixCorruptedTenants();
