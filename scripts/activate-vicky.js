import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const result = await User.updateOne(
      { email: 'vicky@gmail.com' },
      { $set: { isActive: true } }
    );
    console.log('Update result:', result);

    const user = await User.findOne({ email: 'vicky@gmail.com' });
    console.log('User status after update:', user.email, 'isActive:', user.isActive);
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  }
}
//
run();
