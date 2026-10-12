import mongoose from 'mongoose';

const hrPermissionSchema = new mongoose.Schema({
  inspector: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  permissionType: {
    type: String,
    enum: ['half-day', 'short-leave', 'late-arrival', 'early-departure', 'break-extension'],
    required: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  duration: {
    type: Number, // In hours
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  actionedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  actionedAt: {
    type: Date
  },
  affectsAttendance: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

const HRPermission = mongoose.model('HRPermission', hrPermissionSchema);
export default HRPermission;
