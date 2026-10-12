import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';
import connectDB from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the correct location
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database
connectDB();

const assignFormsToDefaultTenant = async () => {
  try {
    console.log('🚀 Assigning forms to default tenant...\n');

    // Get default tenant
    const defaultTenant = await Tenant.findOne({ slug: 'default' });
    
    if (!defaultTenant) {
      console.error('❌ Default tenant not found. Please run createDefaultTenant.js first.');
      process.exit(1);
      return;
    }

    console.log(`✅ Found default tenant: ${defaultTenant.name} (${defaultTenant.slug})`);

    // Find all forms without a tenantId
    const formsWithoutTenant = await Form.find({ 
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null }
      ]
    });

    if (formsWithoutTenant.length === 0) {
      console.log('\n✅ All forms already have a tenant assigned.');
      process.exit(0);
      return;
    }

    console.log(`\n📋 Found ${formsWithoutTenant.length} forms without tenant assignment`);

    // Update all forms to have the default tenant
    const result = await Form.updateMany(
      { 
        $or: [
          { tenantId: { $exists: false } },
          { tenantId: null }
        ]
      },
      { 
        $set: { tenantId: defaultTenant._id }
      }
    );

    console.log(`\n✅ Successfully assigned ${result.modifiedCount} forms to default tenant`);
    console.log('\n🎉 All forms are now accessible at: http://localhost:5174/default/forms/:formId');

  } catch (error) {
    console.error('❌ Failed to assign forms to tenant:', error);
  } finally {
    process.exit(0);
  }
};

// Run script
assignFormsToDefaultTenant();