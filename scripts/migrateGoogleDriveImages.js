import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Response from '../models/Response.js';
import { processResponseImages, isGoogleDriveUrl } from '../services/googleDriveService.js';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/focus_forms';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const hasGoogleDriveImages = (answers) => {
  if (!answers) return false;
  
  let entries = [];
  if (answers instanceof Map) {
    entries = Array.from(answers.entries());
  } else if (typeof answers === 'object') {
    entries = Object.entries(answers);
  } else {
    return false;
  }
  
  for (const [, answer] of entries) {
    if (typeof answer === 'string' && isGoogleDriveUrl(answer)) {
      return true;
    }
    if (Array.isArray(answer)) {
      if (answer.some(item => typeof item === 'string' && isGoogleDriveUrl(item))) {
        return true;
      }
    }
  }
  return false;
};

const migrateResponses = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const responses = await Response.find({});
    console.log(`Found ${responses.length} total responses`);

    let responsesWithImages = 0;
    let processedCount = 0;
    let failedCount = 0;

    for (const response of responses) {
      if (!hasGoogleDriveImages(response.answers)) {
        continue;
      }

      responsesWithImages++;
      console.log(`\n[${responsesWithImages}] Processing response ${response.id}...`);

      try {
        const processedAnswers = await processResponseImages(response.answers);
        
        response.answers = processedAnswers;
        await response.save();

        processedCount++;
        console.log(`✓ Successfully processed response ${response.id}`);

        await sleep(1000);
      } catch (error) {
        failedCount++;
        console.error(`✗ Failed to process response ${response.id}:`, error.message);
      }
    }

    console.log('\n========== Migration Summary ==========');
    console.log(`Total responses: ${responses.length}`);
    console.log(`Responses with Google Drive images: ${responsesWithImages}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log('=====================================\n');

    await mongoose.connection.close();
    console.log('Migration completed');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
};

migrateResponses();
