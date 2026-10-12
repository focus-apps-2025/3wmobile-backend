import mongoose from 'mongoose';
import Form from '../models/Form.js';
import Response from '../models/Response.js';
import dotenv from 'dotenv';

dotenv.config();

async function updateResponseScores() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/focusforms');

    // Find all quiz forms
    const forms = await Form.find({ title: new RegExp('^CitNOW & eVHC Training Quiz') });

    console.log(`Found ${forms.length} quiz forms`);

    for (const form of forms) {
      console.log(`Processing form: ${form.id}`);

      // Get all responses for this form
      const responses = await Response.find({ questionId: form.id });

      console.log(`Found ${responses.length} responses for form ${form.id}`);

      // Collect all questions with correct answers
      const allQuestions = [];
      if (form.sections) {
        form.sections.forEach(section => {
          if (section.questions) {
            allQuestions.push(...section.questions);
          }
        });
      }
      if (form.followUpQuestions) {
        allQuestions.push(...form.followUpQuestions);
      }

      const quizQuestions = allQuestions.filter(q => q.correctAnswer);

      console.log(`Form has ${quizQuestions.length} quiz questions`);

      for (const response of responses) {
        let correct = 0;
        let total = quizQuestions.length;

        quizQuestions.forEach(question => {
          const answer = response.answers.get(question.id);
          if (String(answer).toLowerCase() === String(question.correctAnswer).toLowerCase()) {
            correct++;
          }
        });

        response.score = { correct, total };
        await response.save();

        console.log(`Updated response ${response.id}: ${correct}/${total}`);
      }
    }

    console.log('All responses updated successfully');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

updateResponseScores();