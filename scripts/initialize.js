import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';
import Role from '../models/Permission.js';
import Tenant from '../models/Tenant.js';
import connectDB from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the correct location
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database
connectDB();

const initializeSystem = async () => {
  try {
    console.log('🚀 Initializing Little Flower School System...\n');

    // Create default roles
    console.log('📋 Creating default roles...');
    
    const defaultRoles = [
      {
        id: 'admin-role',
        name: 'Administrator',
        description: 'Full system access with all permissions',
        permissions: [
          'create_forms',
          'edit_forms',
          'delete_forms',
          'view_all_responses',
          'manage_users',
          'manage_roles',
          'view_analytics',
          'export_data',
          'system_settings'
        ],
        canCreateForms: true,
        isSystem: true
      },
      {
        id: 'teacher-role',
        name: 'Teacher',
        description: 'Can create and manage forms, view responses',
        permissions: [
          'create_forms',
          'edit_forms',
          'view_all_responses',
          'view_analytics'
        ],
        canCreateForms: true,
        isSystem: true
      },
      {
        id: 'editor-role',
        name: 'Editor',
        description: 'Can edit forms and view responses',
        permissions: [
          'edit_forms',
          'view_all_responses'
        ],
        canCreateForms: false,
        isSystem: true
      },
      {
        id: 'viewer-role',
        name: 'Viewer',
        description: 'Can only view responses',
        permissions: [
          'view_all_responses'
        ],
        canCreateForms: false,
        isSystem: true
      }
    ];

    // Create or update roles
    for (const roleData of defaultRoles) {
      const existingRole = await Role.findOne({ name: roleData.name });
      
      if (existingRole) {
        console.log(`  ✅ Role "${roleData.name}" already exists`);
      } else {
        const role = new Role(roleData);
        await role.save();
        console.log(`  ✅ Created role: ${roleData.name}`);
      }
    }

    // Create superadmin user first (doesn't need tenantId or createdBy)
    console.log('\n👤 Creating superadmin user...');
    
    const superadminEmail = 'superadmin@gmail.com';
    let superadminUser = await User.findOne({ email: superadminEmail });

    if (superadminUser) {
      console.log('  ✅ Superadmin user already exists');
    } else {
      superadminUser = new User({
        username: 'superadmin',
        email: superadminEmail,
        password: 'srimathi123',
        firstName: 'Super',
        lastName: 'Administrator',
        role: 'superadmin',
        isActive: true,
        mobile: '+1234567890',
        department: 'Administration',
        position: 'Super Administrator'
      });

      await superadminUser.save();
      console.log('  ✅ Created superadmin user');
      console.log('     📧 Email: superadmin@gmail.com');
      console.log('     🔐 Password: srimathi123');
    }

    // Create default tenant
    console.log('\n🏢 Creating default tenant...');
    let defaultTenant = await Tenant.findOne({ slug: 'default' });

    if (defaultTenant) {
      console.log('  ✅ Default tenant already exists');
    } else {
      defaultTenant = new Tenant({
        name: 'Default Business',
        slug: 'default',
        companyName: 'Little Flower School',
        adminId: superadminUser._id,
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
        createdBy: superadminUser._id
      });

      await defaultTenant.save();
      console.log('  ✅ Created default tenant');
      console.log('     Name: Default Business');
      console.log('     Slug: default');
    }

    // Create default admin user for the tenant
    console.log('\n👤 Creating tenant admin user...');
    
    const adminEmail = 'admin@focus.com';
    const existingAdmin = await User.findOne({ email: adminEmail });

    if (existingAdmin) {
      console.log('  ✅ Admin user already exists');
    } else {
      const adminUser = new User({
        username: 'admin',
        email: adminEmail,
        password: 'admin123#',
        firstName: 'System',
        lastName: 'Administrator',
        role: 'admin',
        tenantId: defaultTenant._id,
        isActive: true,
        mobile: '+1234567891',
        department: 'Administration',
        position: 'System Administrator',
        createdBy: superadminUser._id
      });

      await adminUser.save();
      console.log('  ✅ Created admin user');
      console.log('     📧 Email: admin@focus.com');
      console.log('     🔐 Password: admin123#');
    }

    // Get admin user for createdBy reference
    const adminUser = await User.findOne({ email: adminEmail });

    // Create sample teacher user
    console.log('\n👨‍🏫 Creating sample teacher user...');
    
    const teacherEmail = 'teacher@focus.com';
    const existingTeacher = await User.findOne({ email: teacherEmail });

    if (existingTeacher) {
      console.log('  ✅ Teacher user already exists');
    } else {
      const teacherUser = new User({
        username: 'teacher1',
        email: teacherEmail,
        password: 'teacher123',
        firstName: 'John',
        lastName: 'Doe',
        role: 'teacher',
        tenantId: defaultTenant._id,
        isActive: true,
        mobile: '+1234567892',
        department: 'Academic',
        position: 'Mathematics Teacher',
        createdBy: adminUser._id
      });

      await teacherUser.save();
      console.log('  ✅ Created teacher user');
      console.log('     📧 Email: teacher@focus.com');
      console.log('     🔐 Password: teacher123');
    }

    console.log('\n🎉 System initialization completed successfully!');
    console.log('\n📋 Summary:');
    console.log('• Default roles created: Administrator, Teacher, Editor, Viewer');
    console.log('• Default tenant: default (Little Flower School)');
    console.log('• Superadmin user: superadmin@gmail.com / srimathi123');
    console.log('• Admin user: admin@focus.com / admin123#');
    console.log('• Sample teacher: teacher@focus.com / teacher123');
    console.log('\n🚀 You can now start the server and begin using the system!');
    console.log('🌐 Customer portal: http://localhost:5174/default/forms/:formId');

  } catch (error) {
    console.error('❌ Initialization failed:', error);
  } finally {
    process.exit(0);
  }
};

// Run initialization
initializeSystem();