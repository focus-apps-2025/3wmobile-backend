import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import connectDB from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the correct location
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database
connectDB();

const createDefaultTenant = async () => {
  try {
    console.log('🚀 Creating default tenant...\n');

    // Check if default tenant already exists
    const existingTenant = await Tenant.findOne({ slug: 'default' });
    
    if (existingTenant) {
      console.log('✅ Default tenant already exists');
      console.log(`   Name: ${existingTenant.name}`);
      console.log(`   Slug: ${existingTenant.slug}`);
      console.log(`   Active: ${existingTenant.isActive}`);
      process.exit(0);
      return;
    }

    // Get admin user for tenant creation
    const adminUser = await User.findOne({ email: 'admin@focus.com' });
    
    if (!adminUser) {
      console.error('❌ Admin user not found. Please run initialize.js first.');
      process.exit(1);
      return;
    }

    // Create default tenant
    const defaultTenant = new Tenant({
      name: 'Default Business',
      slug: 'default',
      companyName: 'Little Flower School',
      adminId: adminUser._id,
      isActive: true,
      settings: {
        primaryColor: '#3B82F6',
        companyEmail: 'admin@focus.com',
        timezone: 'UTC'
      },
      subscription: {
        plan: 'enterprise',
        startDate: new Date(),
        maxUsers: 100,
        maxForms: 1000
      },
      createdBy: adminUser._id
    });

    await defaultTenant.save();

    console.log('✅ Default tenant created successfully!');
    console.log(`   Name: ${defaultTenant.name}`);
    console.log(`   Slug: ${defaultTenant.slug}`);
    console.log(`   Company: ${defaultTenant.companyName}`);
    console.log(`   Admin: ${adminUser.email}`);
    console.log('\n🎉 You can now access forms at: http://localhost:5174/default/forms/:formId');

  } catch (error) {
    console.error('❌ Failed to create default tenant:', error);
  } finally {
    process.exit(0);
  }
};

// Run script
createDefaultTenant();