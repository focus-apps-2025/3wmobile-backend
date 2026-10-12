import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Form from '../models/Form.js';
import connectDB from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database
connectDB();

/**
 * Migration script to update legacy question types to new types
 * - 'select' -> 'search-select'
 * - 'textarea' -> 'paragraph'
 */
const migrateQuestionTypes = async () => {
  try {
    console.log('🔄 Starting question type migration...\n');

    // Find all forms
    const forms = await Form.find({});
    console.log(`Found ${forms.length} forms to check\n`);

    let updatedCount = 0;
    let questionsMigrated = 0;

    for (const form of forms) {
      let formUpdated = false;
      
      console.log(`Checking form: "${form.title}" (ID: ${form.id})`);

      // Update questions in sections
      if (form.sections && form.sections.length > 0) {
        for (const section of form.sections) {
          if (section.questions && section.questions.length > 0) {
            for (const question of section.questions) {
              if (question.type === 'select') {
                console.log(`  ✓ Migrating question "${question.text}": select -> search-select`);
                question.type = 'search-select';
                formUpdated = true;
                questionsMigrated++;
              } else if (question.type === 'textarea') {
                console.log(`  ✓ Migrating question "${question.text}": textarea -> paragraph`);
                question.type = 'paragraph';
                formUpdated = true;
                questionsMigrated++;
              }

              // Check nested follow-up questions
              if (question.followUpQuestions && question.followUpQuestions.length > 0) {
                const migrateFollowUps = (followUps) => {
                  for (const followUp of followUps) {
                    if (followUp.type === 'select') {
                      console.log(`    ✓ Migrating follow-up "${followUp.text}": select -> search-select`);
                      followUp.type = 'search-select';
                      formUpdated = true;
                      questionsMigrated++;
                    } else if (followUp.type === 'textarea') {
                      console.log(`    ✓ Migrating follow-up "${followUp.text}": textarea -> paragraph`);
                      followUp.type = 'paragraph';
                      formUpdated = true;
                      questionsMigrated++;
                    }

                    // Recursively check nested follow-ups
                    if (followUp.followUpQuestions && followUp.followUpQuestions.length > 0) {
                      migrateFollowUps(followUp.followUpQuestions);
                    }
                  }
                };

                migrateFollowUps(question.followUpQuestions);
              }
            }
          }
        }
      }

      // Update top-level follow-up questions (if any)
      if (form.followUpQuestions && form.followUpQuestions.length > 0) {
        for (const question of form.followUpQuestions) {
          if (question.type === 'select') {
            console.log(`  ✓ Migrating top-level follow-up "${question.text}": select -> search-select`);
            question.type = 'search-select';
            formUpdated = true;
            questionsMigrated++;
          } else if (question.type === 'textarea') {
            console.log(`  ✓ Migrating top-level follow-up "${question.text}": textarea -> paragraph`);
            question.type = 'paragraph';
            formUpdated = true;
            questionsMigrated++;
          }
        }
      }

      // Save the form if it was updated
      if (formUpdated) {
        await form.save();
        updatedCount++;
        console.log(`  ✅ Form updated and saved\n`);
      } else {
        console.log(`  ℹ️  No changes needed\n`);
      }
    }

    console.log('✅ Migration completed successfully!');
    console.log(`\n📊 Summary:`);
    console.log(`  - Total forms checked: ${forms.length}`);
    console.log(`  - Forms updated: ${updatedCount}`);
    console.log(`  - Questions migrated: ${questionsMigrated}`);
    console.log(`\n💡 Legacy types (select, textarea) can now be removed from the schema if desired.`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    process.exit(0);
  }
};

// Run migration
migrateQuestionTypes();