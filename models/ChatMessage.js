import mongoose from 'mongoose';

const ChatMessageSchema = new mongoose.Schema({
  from: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  toEmail: {
    type: String, // Email of the submitter (inspector)
    required: true
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  message: {
    type: String,
    required: true
  },
  responseId: {
    type: String,
    required: true,
    ref: 'Response'
  },
  formId: {
    type: String,
    default: null
  },
  questionIds: [{
    type: String
  }],
  questionTitles: [{
    type: String
  }],
  questionContexts: [{
    questionId: String,
    title: String,
    answer: mongoose.Schema.Types.Mixed,
    suggestion: mongoose.Schema.Types.Mixed
  }],
  isReply: {
    type: Boolean,
    default: false
  },
  parentMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatMessage',
    default: null
  },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read'],
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

ChatMessageSchema.index({ responseId: 1 });
ChatMessageSchema.index({ from: 1 });
ChatMessageSchema.index({ toEmail: 1 });
ChatMessageSchema.index({ tenantId: 1 });

const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);

export default ChatMessage;
