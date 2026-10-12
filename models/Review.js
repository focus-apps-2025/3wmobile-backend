import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema({
  responseId: {
    type: String,
    required: true,
    index: true
  },
  reviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reviewerName: {
    type: String,
    required: true
  },
  reviewerEmail: {
    type: String,
    required: true
  },
  submitterId: {
    type: String,  // ← CHANGE THIS from ObjectId to String
    required: true
  },
  // Tracks what *kind* of value submitterId holds so we never have to
  // guess (regex-test) at query time whether it's an ObjectId, an email,
  // a username, or a raw display name. Written once at creation time.
  submitterIdType: {
    type: String,
    enum: ['objectid', 'email', 'username', 'name'],
    default: 'objectid'
  },
  reviewOption: {
    type: String,
    enum: ['Accepted', 'Rejected', 'Rework'],
    required: true
  },
  scoreChange: {
    type: Number,
    required: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  }
}, {
  timestamps: true
});

// Compound index to ensure one review per reviewer-response pair
reviewSchema.index({ responseId: 1, reviewerId: 1 }, { unique: true });

// NEW - speeds up performance-table lookups that filter/group reviews by
// submitterId (email, username, ObjectId string, or name)
reviewSchema.index({ submitterId: 1 });

// Auto-classify submitterId so callers that don't explicitly set
// submitterIdType still get a correct value for fast lookups later.
reviewSchema.pre('save', function (next) {
  if (this.isModified('submitterId') || !this.submitterIdType) {
    const val = String(this.submitterId || '');
    if (/^[0-9a-f]{24}$/i.test(val)) {
      this.submitterIdType = 'objectid';
    } else if (val.includes('@')) {
      this.submitterIdType = 'email';
    } else if (val.includes(' ')) {
      this.submitterIdType = 'name';
    } else {
      this.submitterIdType = 'username';
    }
  }
  next();
});

const Review = mongoose.model('Reviews', reviewSchema);
export default Review;