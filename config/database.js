import mongoose from 'mongoose';

// Global connection cache across serverless function invocations
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

// Add connection event listeners once
mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connection established');
});
mongoose.connection.on('error', (err) => {
  console.error('⚠️ MongoDB connection error:', err.message || err);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected. Will attempt reconnection on next operation.');
});

const connectDB = async () => {
  // Check if MONGODB_URI is available
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set. Please check your .env file.');
  }

  // 1 = connected
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (cached.conn && cached.conn.readyState === 1) {
    return cached.conn;
  }

  if (!cached.promise) {
    const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const isReplicaSet = process.env.MONGODB_URI.includes('mongodb+srv') || process.env.MONGODB_URI.includes('replicaSet');
    const opts = {
      maxPoolSize: isServerless ? 2 : 20,
      minPoolSize: 0,
      maxIdleTimeMS: 10000,
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      heartbeatFrequencyMS: 15000,
      ...(isReplicaSet ? { retryWrites: true, w: 'majority' } : { retryWrites: false })
    };

    cached.promise = mongoose.connect(process.env.MONGODB_URI, opts).then((conn) => {
      console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
      createDefaultAdmin().catch(err => console.error('Error creating default admin:', err));
      return conn.connection;
    }).catch((err) => {
      cached.promise = null;
      console.error('Database connection error:', err.message || err);
      throw err;
    });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error) {
    cached.promise = null;
    throw error;
  }
};

const createDefaultAdmin = async () => {
  try {
    const User = (await import('../models/User.js')).default;
    
    // Check if superadmin exists
    const superAdminExists = await User.findOne({ role: 'superadmin' });
    
    if (!superAdminExists) {
      const defaultSuperAdmin = new User({
        username: 'superadmin',
        email: 'superadmin@focus.com',
        password: 'superadmin123#', // This will be hashed by the pre-save middleware
        firstName: 'Super',
        lastName: 'Admin',
        role: 'superadmin'
      });
      
      await defaultSuperAdmin.save();
      console.log('Default superadmin created successfully');
      console.log('Username: superadmin');
      console.log('Email: superadmin@focus.com');
      console.log('Password: superadmin123#');
      console.log('Please change the default password after first login!');
      console.log('Use this account to onboard company admins via /api/tenants endpoint');
    }
  } catch (error) {
    console.error('Error creating default superadmin:', error);
  }
};

export default connectDB;