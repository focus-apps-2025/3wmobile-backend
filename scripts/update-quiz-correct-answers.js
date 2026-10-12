import mongoose from 'mongoose';
import Form from '../models/Form.js';
import dotenv from 'dotenv';

dotenv.config();

async function updateQuizCorrectAnswers() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/focusforms');

    // Find all forms with the title starting with CitNOW & eVHC Training Quiz
    const forms = await Form.find({ title: new RegExp('^CitNOW & eVHC Training Quiz') });

    console.log(`Found ${forms.length} quiz forms`);

    // Correct answers mapping: Q4 -> Q1's answer, etc.
    const correctAnswersMap = {
      4: 'B',   // Q1
      5: 'B',   // Q2
      6: 'B',   // Q3
      7: 'A',   // Q4
      8: 'True', // Q5
      9: 'B',   // Q6
      10: 'A',  // Q7
      11: 'B',  // Q8
      12: 'A',  // Q9
      13: 'B',  // Q10
      14: 'B'   // Q11
    };

    for (const form of forms) {
      console.log(`Updating form: ${form.id}`);

      // Update questions q4 to q14 with specific correctAnswer
      if (form.sections) {
        for (const section of form.sections) {
          if (section.questions) {
            for (const question of section.questions) {
              const match = question.id.match(/^q(\d+)$/i);
              if (match) {
                const num = parseInt(match[1]);
                if (num >= 4 && num <= 14 && correctAnswersMap[num]) {
                  question.correctAnswer = correctAnswersMap[num];
                  console.log(`  Set ${question.id} correctAnswer to: ${question.correctAnswer}`);
                }
              }
            }
          }
        }
      }

      await form.save();
      console.log(`Saved form: ${form.id}`);
    }

    console.log('All forms updated successfully');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

updateQuizCorrectAnswers();