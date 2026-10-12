import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Form from './models/Form.js';

dotenv.config();

const checkForm = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    
    const id = '05c5ee44-8a0d-4da2-961f-3b31cb5d5f8e';
    const form = await Form.findOne({ id: id });
    console.log(`Form found by id "${id}":`, !!form);
    if (form) {
      console.log('Form title:', form.title);
      console.log('Form isVisible:', form.isVisible);
      console.log('Form tenantId:', form.tenantId);
    }
    
    if (mongoose.Types.ObjectId.isValid(id)) {
      const form2 = await Form.findById(id);
      console.log(`Form found by _id "${id}":`, !!form2);
    }

    const allForms = await Form.find({}, 'id title').limit(5);
    console.log('Sample forms in DB:', allForms);

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
};

checkForm();
