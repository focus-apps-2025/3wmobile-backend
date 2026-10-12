import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
    mobile: {
        type: String,
        required: false,
        index: true
    },
    email: {
        type: String,
        required: false,
        index: true,
        lowercase: true,
        trim: true
    },
    otp: {
        type: String,
        required: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: '0s' } // TTL index: documents expire at expiresAt
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    verificationId: {
        type: String,
        required: false,
        index: true
    },
    purpose: {
        type: String,
        enum: ['login', 'password-reset', 'signup', 'mobile-verification'],
        default: 'login'
    }
}, {
    timestamps: true
});

// Ensure expiresAt is set correctly if not provided
otpSchema.pre('save', function(next) {
    if (!this.expiresAt) {
        this.expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    }
    next();
});

const Otp = mongoose.model('Otp', otpSchema);

export default Otp;