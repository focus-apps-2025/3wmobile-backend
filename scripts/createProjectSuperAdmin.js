import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables so we can connect to the database
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Convert CLI arguments like --email=value into a config object
const parsedArgs = process.argv.slice(2).reduce((acc, arg) => {
  const [rawKey, ...valueParts] = arg.split('=');
  if (!rawKey || valueParts.length === 0) {
    return acc;
  }

  const key = rawKey.replace(/^--/, '').trim();
  const value = valueParts.join('=').trim();

  if (key) {
    acc[key] = value;
  }

  return acc;
}, {});

const defaults = {
  email: 'superadmin@gmail.com',
  password: 'srimathi123',
  username: 'superadmin',
  firstName: 'Super',
  lastName: 'Admin'
};

const config = {
  email: (parsedArgs.email || defaults.email).toLowerCase(),
  password: parsedArgs.password || defaults.password,
  username: parsedArgs.username || defaults.username,
  firstName: parsedArgs.firstName || defaults.firstName,
  lastName: parsedArgs.lastName || defaults.lastName
};

const ensureUniqueUsername = async (desiredUsername) => {
  let candidate = desiredUsername;
  let counter = 1;

  while (await User.exists({ username: candidate })) {
    candidate = `${desiredUsername}${counter}`;
    counter += 1;
  }

  return candidate;
};

const createOrUpdateSuperAdmin = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is not set. Please populate backend/.env first.');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const existingUser = await User.findOne({ email: config.email });

    if (existingUser) {
      console.log(`ℹ️  Existing account found for ${config.email}. Updating credentials...`);

      existingUser.password = config.password;
      existingUser.role = 'superadmin';
      existingUser.firstName = config.firstName;
      existingUser.lastName = config.lastName;
      existingUser.isActive = true;

      if (parsedArgs.username) {
        existingUser.username = parsedArgs.username;
      }

      await existingUser.save();
      console.log('✅ Super admin credentials updated successfully.');
    } else {
      const uniqueUsername = await ensureUniqueUsername(config.username);

      const superAdmin = new User({
        username: uniqueUsername,
        email: config.email,
        password: config.password,
        firstName: config.firstName,
        lastName: config.lastName,
        role: 'superadmin',
        isActive: true
      });

      await superAdmin.save();
      console.log('✅ Super admin created successfully.');
      console.log('\n📋 Credentials:');
      console.log(`   Email: ${config.email}`);
      console.log(`   Password: ${config.password}`);
      console.log(`   Username: ${uniqueUsername}`);
    }
  } catch (error) {
    console.error('❌ Failed to create or update super admin:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 MongoDB connection closed.');
  }
};

createOrUpdateSuperAdmin();