import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Form from './models/Form.js';
import Response from './models/Response.js';

dotenv.config();

const debug = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find all responses for Chassis N603
    const responses = await Response.find({ questionId: '5ac957f2-d829-46ee-8507-54d6027aa2c7' });
    console.log('Total responses found:', responses.length);

    responses.forEach((r, idx) => {
      console.log(`\nResponse #${idx + 1}:`);
      console.log('  _id:', r._id);
      console.log('  createdAt:', r.createdAt);
      console.log('  submittedBy:', r.submittedBy);
      console.log('  createdBy:', r.createdBy);
      console.log('  tenantId:', r.tenantId);
      console.log('  isSectionSubmit:', r.isSectionSubmit);
      console.log('  answers:', r.answers);
    });

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
};

debug();
