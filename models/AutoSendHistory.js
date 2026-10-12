import mongoose from 'mongoose';

const autoSendHistorySchema = new mongoose.Schema({
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
  type: {
    type: String,
    enum: ['email', 'whatsapp'],
    required: true
  },
  recipient: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['success', 'failed'],
    required: true
  },
  details: {
    includePdf: Boolean,
    includeLink: Boolean,
    error: String
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

autoSendHistorySchema.index({ formId: 1, sentAt: -1 });

export default mongoose.model('AutoSendHistory', autoSendHistorySchema);
