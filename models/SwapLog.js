import mongoose from 'mongoose';

const SwapLogSchema = new mongoose.Schema({
  sourceUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sourceDate: {          // ✅ Changed from 'date'
    type: String,        // 'YYYY-MM-DD'
    required: true
  },
  targetDate: {          // ✅ New field
    type: String,        // 'YYYY-MM-DD'
    required: true
  },
  formId: {
    type: String,
    required: true
  },
  swappedResponses: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Response'
  }],
  newResponses: [{       // ✅ New field to track created responses
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Response'
  }],
  quantities: {
    directOk: { type: Number, default: 0 },
    reworkCompleted: { type: Number, default: 0 },
    reworkPending: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 }
  },
  swappedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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

const SwapLog = mongoose.model('SwapLog', SwapLogSchema);
export default SwapLog;