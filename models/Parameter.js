import mongoose from 'mongoose';

const ParameterSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['main', 'followup'],
    required: true
  },
  formId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Form',
    required: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Compound index to ensure unique parameter names per form, tenant and type (when formId exists)
ParameterSchema.index({ name: 1, formId: 1, tenantId: 1, type: 1 }, {
  unique: true,
  partialFilterExpression: { formId: { $exists: true } }
});

// Separate index for parameters without formId (legacy support)
ParameterSchema.index({ name: 1, tenantId: 1, type: 1 }, {
  unique: true,
  partialFilterExpression: { formId: { $exists: false } }
});

// Index for efficient queries
ParameterSchema.index({ tenantId: 1 });
ParameterSchema.index({ formId: 1 });
ParameterSchema.index({ type: 1 });
ParameterSchema.index({ createdBy: 1 });

const Parameter = mongoose.model('Parameter', ParameterSchema);

export default Parameter;