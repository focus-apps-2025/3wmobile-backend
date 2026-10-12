import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';
import connectDB from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database
connectDB();

const checkForm = async () => {
  try {
    const formId = '76b9a246-4c3a-422f-8b13-10a5d30c4305';
    
    console.log(`🔍 Checking form: ${formId}\n`);

    // Find the form
    const form = await Form.findOne({ id: formId }).populate('tenantId');
    
    if (!form) {
      console.log('❌ Form not found in database');
      
      // List all forms
      const allForms = await Form.find().select('id title tenantId isVisible').limit(10);
      console.log(`\n📋 Available forms (showing first 10):`);
      for (const f of allForms) {
        console.log(`   • ${f.id} - ${f.title} (visible: ${f.isVisible}, tenantId: ${f.tenantId || 'none'})`);
      }
    } else {
      console.log('✅ Form found!');
      console.log(`   Title: ${form.title}`);
      console.log(`   Description: ${form.description}`);
      console.log(`   Visible: ${form.isVisible}`);
      console.log(`   Tenant ID: ${form.tenantId}`);
      
      if (form.tenantId) {
        const tenant = await Tenant.findById(form.tenantId);
        if (tenant) {
          console.log(`   Tenant: ${tenant.name} (${tenant.slug})`);
          console.log(`   Tenant Active: ${tenant.isActive}`);
          console.log(`\n✅ Form should be accessible at: http://localhost:5174/${tenant.slug}/forms/${formId}`);
        } else {
          console.log('   ⚠️  Tenant not found for this form');
        }
      } else {
        console.log('   ⚠️  Form has no tenant assigned');
      }
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    process.exit(0);
  }
};

// Run script
checkForm();