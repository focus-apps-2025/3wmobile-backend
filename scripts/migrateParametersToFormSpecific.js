import mongoose from 'mongoose';
import Parameter from '../models/Parameter.js';
import Form from '../models/Form.js';
import dotenv from 'dotenv';

dotenv.config();

function generateId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2, 11)}`;
}

const migrateParameters = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || process.env.DATABASE_URL);
    console.log('Connected to MongoDB');

    // Get all parameters that don't have formId
    const parametersWithoutFormId = await Parameter.find({ formId: { $exists: false } });
    console.log(`Found ${parametersWithoutFormId.length} parameters without formId`);

    if (parametersWithoutFormId.length === 0) {
      console.log('No parameters need migration');
      return;
    }

    // Group parameters by tenant
    const parametersByTenant = {};
    parametersWithoutFormId.forEach(param => {
      if (!parametersByTenant[param.tenantId]) {
        parametersByTenant[param.tenantId] = [];
      }
      parametersByTenant[param.tenantId].push(param);
    });

    // For each tenant, create a default "Global Parameters" form if it doesn't exist
    for (const [tenantId, params] of Object.entries(parametersByTenant)) {
      console.log(`Processing tenant ${tenantId} with ${params.length} parameters`);

      // Check if a "Global Parameters" form already exists for this tenant
      let globalForm = await Form.findOne({
        title: 'Global Parameters',
        tenantId: tenantId
      });

      if (!globalForm) {
        // Create a default global form for parameters
        globalForm = new Form({
          id: generateId(),
          title: 'Global Parameters',
          description: 'Default form for migrated global parameters',
          tenantId: tenantId,
          sections: [],
          followUpQuestions: [],
          isVisible: false, // Hidden form
          createdBy: params[0].createdBy // Use the creator of the first parameter
        });

        await globalForm.save();
        console.log(`Created global form ${globalForm._id} for tenant ${tenantId}`);
      }

      // Update all parameters for this tenant to use the global form
      await Parameter.updateMany(
        { tenantId: tenantId, formId: { $exists: false } },
        { formId: globalForm._id }
      );

      console.log(`Updated ${params.length} parameters for tenant ${tenantId}`);
    }

    console.log('Migration completed successfully');

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

// Run the migration
migrateParameters();