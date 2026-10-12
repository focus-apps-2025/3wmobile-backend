import mongoose from 'mongoose';  
import Parameter from '../models/Parameter.js';  
import Form from '../models/Form.js';  
import dotenv from 'dotenv';  
  
dotenv.config();  
  
const seedDefaultParameters = async () => {  
  try {  
    // Connect to MongoDB  
