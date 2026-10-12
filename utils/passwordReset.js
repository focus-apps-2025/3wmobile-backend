import Otp from '../models/Otp.js';
import User from '../models/User.js';
import LoginLog from '../models/LoginLog.js';
import crypto from 'crypto';

/**
 * @desc    Generate a secure verification ID for password reset flow
 * @returns {string} Hex-encoded verification token
 */
export const generateVerificationId = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * @desc    Check if too many password reset attempts from this email
 * @param {string} email
 * @param {number} [maxAttempts=5]
 * @param {number} [windowMs=3600000] - 1 hour window
 * @returns {Promise<{allowed: boolean, attempts: number, remainingTime: number}>}
 */
export const checkPasswordResetRateLimit = async (email, maxAttempts = 5, windowMs = 3600000) => {
  const windowStart = new Date(Date.now() - windowMs);
  
  const recentAttempts = await Otp.find({
    email: email.toLowerCase().trim(),
    createdAt: { $gte: windowStart },
    purpose: 'password-reset'
  });

  return {
    allowed: recentAttempts.length < maxAttempts,
    attempts: recentAttempts.length,
    remainingTime: windowMs - (Date.now() - new Date(recentAttempts[0]?.createdAt || Date.now()).getTime())
  };
};

/**
 * @desc    Invalidate all existing password reset sessions for an email
 * @param {string} email
 */
export const invalidateExistingResetSessions = async (email) => {
  await Otp.updateMany(
    { 
      email: email.toLowerCase().trim(),
      purpose: 'password-reset',
      isVerified: false 
    },
    { isVerified: true }
  );
};

/**
 * @desc    Clean up expired OTP records for an email
 * @param {string} email
 */
export const cleanupExpiredOtps = async (email) => {
  await Otp.deleteMany({
    email: email.toLowerCase().trim(),
    expiresAt: { $lt: new Date() }
  });
};

/**
 * @desc    Log password reset activity
 * @param {ObjectId} userId
 * @param {ObjectId} tenantId
 * @param {string} ipAddress
 * @param {string} userAgent
 */
export const logPasswordResetActivity = async (userId, tenantId, ipAddress, userAgent) => {
  try {
    await LoginLog.create({
      userId,
      tenantId,
      location: { status: 'password-reset' },
      ipAddress,
      userAgent
    });
  } catch (err) {
    console.error('Failed to log password reset activity:', err);
  }
};

/**
 * @desc    Validate password strength
 * @param {string} password
 * @returns {{valid: boolean, errors: string[]}}
 */
export const validatePasswordStrength = (password) => {
  const errors = [];
  
  if (password.length < 6) {
    errors.push('Password must be at least 6 characters long');
  }
  
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
};
