// In Response.js - Update the submissionMetadata object
import mongoose from 'mongoose';

const ResponseSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true
  },
  questionId: {
    type: String,
    required: true,
    ref: 'Form'
  },
  answers: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    required: true
  },
  parentResponseId: {
    type: String,
    index: true
  },
  batchId: {
    type: String,
    index: true
  },
  chassisNumber: {
    type: String,
    index: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedAt: Date,
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verifiedAt: Date,
  status: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  notes: String,
  isSectionSubmit: {
    type: Boolean,
    default: false
  },
  sectionIndex: {
    type: Number,
    default: null
  },
  score: {
    correct: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  submittedBy: String, // Can store name or identifier of the person who submitted
  submittedAt: {
    type: Date,
    index: true
  },
  submitterContact: {
    email: String,
    phone: String
  },
  inviteId: {
    type: String,
    ref: 'FormInvite',
    index: true,
    default: null
  }, // Location and metadata tracking
  submissionMetadata: {
    ipAddress: String,
    formSessionId: String,
    userAgent: String,
    browser: String,
    device: String,
    os: String,
    location: {
      country: String,
      countryCode: String,
      region: String,
      city: String,
      latitude: Number,
      longitude: Number,
      timezone: String,
      isp: String
    },
    capturedLocation: {
      latitude: Number,
      longitude: Number,
      accuracy: Number,
      source: {
        type: String,
        enum: ['browser', 'ip', 'manual', 'unknown'],
        default: 'unknown'
      },
      city: String,
      region: String,
      country: String,
      capturedAt: {
        type: Date,
        default: Date.now
      }
    },
    submittedAt: {
      type: Date,
      default: Date.now
    },
    source: {
      type: String,
      default: 'external'
    },
  },
  // ========== ADD THESE NEW TIMING FIELDS ==========
  // Total time spent on the form (in seconds)
  timeSpent: {
    type: Number,
    default: 0,
    min: 0
  },
  // Session ID from FormSession
  sessionId: {
    type: String,
    default: null
  },
  // When the user started the form
  startedAt: {
    type: Date,
    default: null
  },
  // When the user completed/submitted
  completedAt: {
    type: Date,
    default: null

  },

  // ========== ADD NEW TOP-LEVEL TIMING FIELDS (for easier querying) ==========
  // These make it easier to query and aggregate time data
  timeSpent: {
    type: Number, // in seconds
    default: 0,
    index: true
  },
  sessionId: {
    type: String,
    index: true,
    default: null
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },

  // Question-level timings (if you want per-question data)
  questionTimings: [{
    questionId: String,
    questionText: String,
    questionType: String,
    timeSpent: Number, // seconds spent on this question
    order: Number,
    startedAt: Date,
    completedAt: Date
  }],

  tenantId: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'Tenant',
    required: true
  },
  isDispatched: {
    type: Boolean,
    default: false
  },
  dispatchedAt: {
    type: Date
  },
  dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dispatchedByName: { type: String, default: null },
  // BIW Review — a second, independent accept/reject/rework check that any
  // reviewer other than the response's own submitter can apply, separate
  // from the main verifiedBy/status review flow.
  biwReview: {
    status: {
      type: String,
      enum: ['Accepted', 'Rejected', 'Reworked']
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedByName: String,
    reviewedAt: Date,
    reason: String,
    remark: String,
    evidenceUrl: String,
    flaggedQuestions: [{
      questionId: String,
      questionText: String
    }]
  }
}, {
  timestamps: true,
  toObject: {
    transform: function (doc, ret) {
      if (ret.submittedAt) {
        ret.createdAt = ret.submittedAt;
      }
      return ret;
    }
  },
  toJSON: {
    transform: function (doc, ret) {
      if (ret.submittedAt) {
        ret.createdAt = ret.submittedAt;
      }
      return ret;
    }
  }
});

// ========== ADD NEW INDEXES FOR TIME QUERIES ==========
ResponseSchema.index({ questionId: 1 });
ResponseSchema.index({ assignedTo: 1 });
ResponseSchema.index({ status: 1 });
ResponseSchema.index({ createdAt: -1 });
ResponseSchema.index({ tenantId: 1 });
ResponseSchema.index({ startedAt: -1 }); // NEW - for time range queries
ResponseSchema.index({ timeSpent: 1 }); // NEW - for time-based queries
ResponseSchema.index({ sessionId: 1 });  // NEW - for session lookups
ResponseSchema.index({ 'biwReview.status': 1 }); // NEW - for BIW review table queries

// ========== NEW - PERFORMANCE TABLE PAGINATION INDEXES ==========
// Support skip()/limit() + sort({createdAt:-1}) pagination scoped by form
// or by tenant, without a full collection scan.
ResponseSchema.index({ questionId: 1, createdAt: -1 });
ResponseSchema.index({ questionId: 1, isSectionSubmit: 1, createdAt: -1 });
ResponseSchema.index({ tenantId: 1, createdAt: -1 });
ResponseSchema.index({ tenantId: 1, isSectionSubmit: 1, createdAt: -1 }); // NEW - to fix responses?limit=1000 timeouts
ResponseSchema.index({ createdBy: 1, createdAt: -1, tenantId: 1 });
ResponseSchema.index({ chassisNumber: 1 });
ResponseSchema.index({ parentResponseId: 1 });
ResponseSchema.index({ batchId: 1 });
ResponseSchema.index({ questionId: 1, chassisNumber: 1 });
ResponseSchema.index({ 'answers.chassis_number': 1 });
ResponseSchema.index({ 'answers.chassisNumber': 1 });

// ========== PRE-SAVE HOOK FOR ROBUST CREATOR ASSIGNMENT ==========
ResponseSchema.pre('save', async function (next) {
  if (!this.createdBy && this.tenantId) {
    try {
      const User = mongoose.model('User');

      // 1. Try to find a user matching submittedBy identifier if valid
      if (this.submittedBy && this.submittedBy !== 'Excel Import') {
        const submittedClean = String(this.submittedBy).trim();
        let matchedUser = await User.findOne({
          tenantId: this.tenantId,
          $or: [
            { email: { $regex: new RegExp(`^${submittedClean}$`, 'i') } },
            { username: { $regex: new RegExp(`^${submittedClean}$`, 'i') } }
          ]
        });

        if (!matchedUser) {
          const users = await User.find({ tenantId: this.tenantId });
          matchedUser = users.find(u => {
            const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim();
            return fullName.toLowerCase() === submittedClean.toLowerCase();
          });
        }

        if (matchedUser) {
          this.createdBy = matchedUser._id;
          return next();
        }
      }

      // 2. Fallback to tenant admin
      let fallbackUser = await User.findOne({ tenantId: this.tenantId, role: 'admin' });

      // 3. Fallback to any tenant user
      if (!fallbackUser) {
        fallbackUser = await User.findOne({ tenantId: this.tenantId });
      }

      if (fallbackUser) {
        this.createdBy = fallbackUser._id;
      }
    } catch (error) {
      console.error('Error in Response pre-save hook:', error);
    }
  }
  next();
});

// ─── Critical Performance Indexes ────────────────────────────────────────────
// These compound indexes cover the most common query patterns.
// Without them, every getAllResponses / getResponsesByForm call does a full
// collection scan, which gets exponentially slower as the collection grows.

// Primary listing query: filter by tenantId, sort by createdAt desc
ResponseSchema.index({ tenantId: 1, createdAt: -1 });

// Form-specific queries: filter by questionId (formId), sort by createdAt desc
ResponseSchema.index({ questionId: 1, createdAt: -1 });

// Inspector queries: filter by createdBy + questionId
ResponseSchema.index({ createdBy: 1, questionId: 1, createdAt: -1 });

// Status filtering
ResponseSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

// Section submit filter (used in almost every query)
ResponseSchema.index({ isSectionSubmit: 1 });

// Submitted by search
ResponseSchema.index({ submittedBy: 1 });

const Response = mongoose.model('Response', ResponseSchema);

export default Response;