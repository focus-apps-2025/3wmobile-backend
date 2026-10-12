import mongoose from 'mongoose';

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: /^[a-z0-9-]+$/,
    maxlength: 50
  },
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  adminId: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  internalTrackingEnabled: {
    type: Boolean,
    default: false
  },
  allowedTenantIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant'
  }],
  settings: {
    logo: String,
    primaryColor: {
      type: String,
      default: '#3B82F6'
    },
    companyEmail: String,
    companyPhone: String,
    address: String,
    showCustomerPortal: {
      type: Boolean,
      default: false
    },
    timezone: {
      type: String,
      default: 'UTC'
    },
    officeLocation: {
      lat: Number,
      lng: Number,
      radius: {
        type: Number,
        default: 500
      }
    }
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'basic', 'premium', 'enterprise'],
      default: 'basic'
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: Date,
    maxUsers: {
      type: Number,
      default: 10
    },
    maxForms: {
      type: Number,
      default: 50
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index for faster queries
tenantSchema.index({ adminId: 1 });
tenantSchema.index({ isActive: 1 });

// Transform toJSON
tenantSchema.methods.toJSON = function() {
  const tenantObject = this.toObject();
  return tenantObject;
};

const Tenant = mongoose.model('Tenant', tenantSchema);

export default Tenant;