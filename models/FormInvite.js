// models/FormInvite.js
import mongoose from 'mongoose';

const formInviteSchema = new mongoose.Schema({
  formId: {
    type: String,
    required: true,
    index: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  email: {
    type: String,
    required: false,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    default: '',
    trim: true
  },
  inviteId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['sent', 'responded', 'expired'],
    default: 'sent'
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  respondedAt: {
    type: Date
  },
  notificationChannels: {
    type: [String],
    default: [],
    enum: ['email', 'sms', 'whatsapp']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

formInviteSchema.index({ formId: 1, email: 1 }); // Regular index, not unique
formInviteSchema.index({ formId: 1, phone: 1 }); // Regular index, not unique
formInviteSchema.index({ status: 1 });

export default mongoose.model('FormInvite', formInviteSchema);