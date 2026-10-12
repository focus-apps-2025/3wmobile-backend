import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const createSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if superadmin already exists
    const existingSuperAdmin = await User.findOne({ role: 'superadmin' });
    if (existingSuperAdmin) {
      console.log('⚠️  SuperAdmin already exists:');
      console.log('   Email:', existingSuperAdmin.email);
      console.log('   Username:', existingSuperAdmin.username);
      
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question('Do you want to create another superadmin? (yes/no): ', async (answer) => {
        if (answer.toLowerCase() !== 'yes') {
          console.log('❌ Operation cancelled');
          rl.close();
          process.exit(0);
        }
        rl.close();
        await createNewSuperAdmin();
      });
    } else {
      await createNewSuperAdmin();
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

const createNewSuperAdmin = async () => {
  try {
    // SuperAdmin details
    const superAdminData = {
      username: 'superadmin',
      email: 'superadmin@focus.com',
      password: 'Super@123',
      firstName: 'Super',
      lastName: 'Admin',
      role: 'superadmin',
      isActive: true
    };

    // Create superadmin
    const superAdmin = new User(superAdminData);
    await superAdmin.save();

    console.log('\n✅ SuperAdmin created successfully!');
    console.log('\n📋 SuperAdmin Credentials:');
    console.log('   Email:', superAdminData.email);
    console.log('   Password:', superAdminData.password);
    console.log('   Role:', superAdminData.role);
    console.log('\n⚠️  IMPORTANT: Please change the password after first login!');
    console.log('\n🌐 Login URL: http://localhost:3000/login');
    console.log('   (SuperAdmin does not need tenant slug)');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating superadmin:', error.message);
    process.exit(1);
  }
};

createSuperAdmin();