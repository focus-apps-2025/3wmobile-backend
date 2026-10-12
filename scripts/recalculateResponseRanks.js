import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Response from '../models/Response.js';
import Form from '../models/Form.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/3w-wheeler';

const extractAnswerString = (ans) => {
  if (ans === null || ans === undefined) return '';
  if (typeof ans === 'object') {
    if (ans.chassisNumber !== undefined && ans.chassisNumber !== null) {
      return String(ans.chassisNumber).trim();
    }
    if (ans.value !== undefined && ans.value !== null) {
      return String(ans.value).trim();
    }
    if (ans.text !== undefined && ans.text !== null) {
      return String(ans.text).trim();
    }
    if (ans.chassis !== undefined && ans.chassis !== null) {
      return String(ans.chassis).trim();
    }
    return '';
  }
  return String(ans).trim();
};

const collectAllQuestions = (questions, result = []) => {
  if (!Array.isArray(questions)) return result;
  questions.forEach((q) => {
    result.push(q);
    if (Array.isArray(q.followUpQuestions)) {
      collectAllQuestions(q.followUpQuestions, result);
    }
  });
  return result;
};

const recalculateAllRanks = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    const forms = await Form.find({}).lean();
    console.log(`Found ${forms.length} forms to process.`);

    for (const form of forms) {
      const allQuestions = [];
      if (form.sections) {
        form.sections.forEach((s) => {
          if (s.questions) collectAllQuestions(s.questions, allQuestions);
        });
      }
      if (form.followUpQuestions) {
        collectAllQuestions(form.followUpQuestions, allQuestions);
      }

      const rankTrackedQuestions = allQuestions.filter(
        (q) => q.trackResponseRank || q.trackResponseQuestion
      );

      if (rankTrackedQuestions.length === 0) continue;

      const formIds = [form.id, form._id ? form._id.toString() : null].filter(Boolean);
      console.log(`Processing form "${form.title}" (${form.id}) with ${rankTrackedQuestions.length} tracked questions...`);

      const responses = await Response.find({
        questionId: { $in: formIds },
        isSectionSubmit: { $ne: true }
      }).sort({ createdAt: 1 });

      console.log(`Found ${responses.length} responses for form ${form.id}. Recalculating ranks...`);

      const answerTracker = {};
      rankTrackedQuestions.forEach((q) => {
        answerTracker[q.id] = new Map();
      });

      let updatedCount = 0;

      for (const resp of responses) {
        const answersObj = resp.answers instanceof Map ? Object.fromEntries(resp.answers) : (resp.answers || {});
        const newResponseRanks = {};

        for (const question of rankTrackedQuestions) {
          const qId = question.id;
          const trackingQId = `${qId}_tracking`;
          const rawAns = answersObj[qId] !== undefined ? answersObj[qId] : answersObj[trackingQId];
          const answerStr = extractAnswerString(rawAns);

          if (answerStr !== '') {
            const key = answerStr.toLowerCase();
            const map = answerTracker[qId];
            const currentCount = map.get(key) || 0;
            const newRank = currentCount + 1;
            newResponseRanks[qId] = newRank;
            map.set(key, newRank);
          }
        }

        resp.responseRanks = new Map(Object.entries(newResponseRanks));
        await resp.save();
        updatedCount++;
      }

      console.log(`Successfully updated ${updatedCount} responses for form ${form.id}.`);
    }

    console.log('Recalculation complete!');
    process.exit(0);
  } catch (err) {
    console.error('Error recalculating ranks:', err);
    process.exit(1);
  }
};

recalculateAllRanks();
