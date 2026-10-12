import mongoose from 'mongoose';

const loginLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant'
  },
  loginTime: {
    type: Date,
    default: Date.now,
    required: true
  },
  logoutTime: {
    type: Date
  },
  location: {
     latitude: Number,
     longitude: Number,
     address: String,
     city: String,
     country: String,
     countryCode: String,
     status: {
       type: String,
       enum: ['granted', 'denied', 'unknown', 'browser', 'password-reset'],
       default: 'unknown'
     }
   },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  sessionToken: {
    type: String
  },
  // Attendance specific fields
  workingHours: {
    type: Number,
    default: 0
  },
  isPresent: {
    type: Boolean,
    default: false
  },
  presentStatus: {
    type: String,
    enum: ['present', 'absent', 'half-day', 'leave'],
    default: 'absent'
  },
  // For tracking current status
  lastActiveTime: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Virtual for calculating working hours
loginLogSchema.virtual('calculatedWorkingHours').get(function () {
  if (!this.logoutTime || !this.loginTime) return 0;
  const diff = this.logoutTime.getTime() - this.loginTime.getTime();
  return Math.round(diff / (1000 * 60 * 60) * 10) / 10; // Hours with 1 decimal
});

// Method to mark as present
loginLogSchema.methods.markPresent = function () {
  this.isPresent = true;
  this.presentStatus = 'present';
  return this.save();
};

// Method to update last active
loginLogSchema.methods.updateLastActive = function () {
  this.lastActiveTime = new Date();
  this.isActive = true;
  return this.save();
};

const LoginLog = mongoose.model('LoginLog', loginLogSchema);

export default LoginLog;
