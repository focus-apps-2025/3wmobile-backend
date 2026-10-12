// models/FormSession.js
import mongoose from 'mongoose';

const formSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false, // Changed to false for anonymous users
    index: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true, // Still required for isolation, but we'll ensure it's fetched from the form
    index: true
  },
  userRole: {
    type: String,
    enum: ['superadmin', 'admin', 'subadmin', 'teacher', 'student', 'staff', 'editor', 'viewer', 'inspector', 'anonymous'],
    default: 'anonymous'
  },
  formId: {
    type: String, // Custom form ID from Form model
    required: true,
    index: true
  },
  formTitle: String,
  startedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  lastActivityAt: {
    type: Date,
    default: Date.now
  },
  timeSpent: Number, // Total seconds spent on this form
  status: {
    type: String,
    enum: ['in-progress', 'completed', 'abandoned'],
    default: 'in-progress'
  },
  // Track time per question
  questionTimings: [{
    questionId: String,
    questionText: String,
    questionType: String,
    sectionId: String,
    sectionTitle: String,
    startedAt: Date,
    endedAt: Date,
    timeSpent: Number, // seconds
    answer: mongoose.Schema.Types.Mixed
  }],
  
  // Track time per section
  sectionTimings: [{
    sectionId: String,
    sectionTitle: String,
    startedAt: Date,
    endedAt: Date,
    timeSpent: Number, // seconds
    questionCount: Number
  }],
  
  // Final answers (for reference)
  answers: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Invite tracking (for public users)
  inviteId: {
    type: String,
    ref: 'FormInvite',
    index: true
  },
  
  metadata: {
    userAgent: String,
    ipAddress: String,
    deviceType: String,
    browser: String,
    os: String
  }
}, {
  timestamps: true
});

// Indexes
formSessionSchema.index({ userId: 1, formId: 1, startedAt: -1 });
formSessionSchema.index({ tenantId: 1, formId: 1, status: 1 });
formSessionSchema.index({ tenantId: 1, startedAt: -1 });
formSessionSchema.index({ completedAt: 1 });

const FormSession = mongoose.model('FormSession', formSessionSchema);

export default FormSession;