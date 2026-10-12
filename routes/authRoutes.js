import express from 'express';
import { login, logout, signup, getProfile, changePassword, forgotPassword, verifyForgotOtp, resetPassword, resendForgotOtp } from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { validateLogin } from '../middleware/validation.js';

const router = express.Router();

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', validateLogin, login);

// @route   POST /api/auth/logout
// @desc    Logout user and record logout time
// @access  Public (works even with expired token to ensure logout is always recorded)
router.post('/logout', logout);

// @route   POST /api/auth/signup
// @desc    Signup new tenant (Free Trial)
// @access  Public
router.post('/signup', signup);

// @route   POST /api/auth/forgot-password
// @desc    Request password reset OTP (sent to registered mobile)
// @access  Public
router.post('/forgot-password', forgotPassword);

// @route   POST /api/auth/resend-otp
// @desc    Resend OTP for password reset (with rate limiting)
// @access  Public
router.post('/resend-otp', resendForgotOtp);

// @route   POST /api/auth/verify-forgot-otp
// @desc    Verify OTP for password reset
// @access  Public
router.post('/verify-forgot-otp', verifyForgotOtp);

// @route   POST /api/auth/reset-password
// @desc    Reset password after OTP verification
// @access  Public
router.post('/reset-password', resetPassword);

// @route   GET /api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', authenticate, getProfile);

// @route   PUT /api/auth/change-password
// @desc    Change user password
// @access  Private
router.put('/change-password', authenticate, changePassword);

export default router;