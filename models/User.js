import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 50
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'subadmin', 'teacher', 'student', 'staff', 'editor', 'viewer', 'inspector'],
    default: 'student'
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: function () {
      // Only superadmin doesn't need tenantId, all others (including admin) need it
      return this.role !== 'superadmin';
    }
  },
  customRole: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role'
  },
  firstName: {
    type: String,
    required: true,
    trim: true
  },
  lastName: {
    type: String,
    required: true,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  accessType: {
    type: String,
    enum: ['website', 'mobile', 'both'],
    default: 'both'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  attendanceOTP: String,
  attendanceOTPVerified: { type: Boolean, default: false },
  lastLogin: {
    type: Date
  },
  mobile: String,
  avatar: String,
  department: String,
  position: String,
  permissions: [{
    type: String
  }],
  performanceScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  acceptedCount: {
    type: Number,
    default: 0
  },
  rejectedCount: {
    type: Number,
    default: 0
  },
  reworkCount: {
    type: Number,
    default: 0
  },
  granularPermissions: {
    canEditAttendanceTime: {
      type: Boolean,
      default: false
    },
    canEditInvoices: {
      type: Boolean,
      default: false
    },
    canEditPricing: {
      type: Boolean,
      default: false
    }
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(8);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Transform toJSON to remove sensitive data
userSchema.methods.toJSON = function () {
  const userObject = this.toObject();
  delete userObject.password;
  return userObject;
};

userSchema.index({ email: 1 });
userSchema.index({ username: 1 });

const User = mongoose.model('User', userSchema);

export default User;