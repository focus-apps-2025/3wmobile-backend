import mongoose from 'mongoose';

const shiftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  startTime: {
    type: String,
    required: true,
    match: [/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:MM format']
  },
  endTime: {
    type: String,
    required: true,
    match: [/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:MM format']
  },
  gracePeriod: {
    type: Number,
    default: 15 // minutes
  },
  lateMarkingAfter: {
    type: Number,
    default: 30 // minutes
  },
  halfDayMarkingAfter: {
    type: Number,
    default: 120 // minutes
  },
  assignedInspectors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isNightShift: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
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

// Indexes
shiftSchema.index({ tenantId: 1, isActive: 1 });
shiftSchema.index({ tenantId: 1, assignedInspectors: 1 });
shiftSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const Shift = mongoose.model('Shift', shiftSchema);

export default Shift;
