import mongoose from 'mongoose';

const analyticsInviteSchema = new mongoose.Schema({
  formId: {
    type: String,
    required: true,
    index: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    index: true
  },
  phone: {
    type: String,
    trim: true
  },
  otp: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  lastLogin: {
    type: Date
  },
  status: {
    type: String,
    enum: ['sent', 'active', 'expired'],
    default: 'sent'
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  }
}, {
  timestamps: true
});

// Ensure quick lookup per form and identity (Removed unique constraint to allow duplicates)
analyticsInviteSchema.index({ formId: 1, email: 1 });
analyticsInviteSchema.index({ formId: 1, phone: 1 });

const AnalyticsInvite = mongoose.model('AnalyticsInvite', analyticsInviteSchema);

export default AnalyticsInvite;
