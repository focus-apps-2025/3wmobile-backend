import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import Shift from '../models/Shift.js';
import LoginLog from '../models/LoginLog.js';
import Otp from '../models/Otp.js';
import Form from '../models/Form.js';
import Response from '../models/Response.js';
import Review from '../models/Review.js';
import { generateToken } from '../middleware/auth.js';
import crypto from 'crypto';
import axios from 'axios';
import smsService from '../services/smsService.js';

// Helper function to get location from IP address
const getLocationFromIP = async (ip) => {
  try {
    // Skip private/local IPs
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return null;
    }

    const response = await axios.get(`http://ip-api.com/json/${ip}`, {
      timeout: 3000
    });

    if (response.data && response.data.status === 'success') {
      return {
        city: response.data.city,
        country: response.data.country,
        countryCode: response.data.countryCode,
        latitude: response.data.lat,
        longitude: response.data.lon,
        status: 'ip-based'
      };
    }
  } catch (error) {
    console.error('IP location lookup failed:', error.message);
  }
  return null;
};

// Helper to combine browser geolocation with IP-based location
const enhanceLocationData = async (browserLocation, ipAddress) => {
  let locationData = {
    status: 'unknown',
    latitude: null,
    longitude: null,
    city: null,
    country: null,
    countryCode: null
  };

  // Use browser coordinates if available
  if (browserLocation && browserLocation.status === 'granted' && browserLocation.latitude) {
    locationData.latitude = browserLocation.latitude;
    locationData.longitude = browserLocation.longitude;
    locationData.status = 'browser';

    // Try to get city/country from IP (reverse geocode)
    const ipLocation = await getLocationFromIP(ipAddress);
    if (ipLocation) {
      locationData.city = ipLocation.city;
      locationData.country = ipLocation.country;
      locationData.countryCode = ipLocation.countryCode;
    }
  } else {
    // Fallback to IP-based location
    const ipLocation = await getLocationFromIP(ipAddress);
    if (ipLocation) {
      locationData = ipLocation;
    }
  }

  return locationData;
};

export const login = async (req, res) => {
  try {
    const { username, email, password, tenantSlug, location } = req.body;
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    // Find user by username or email
    let user;
    console.log('--- DEBUG LOGIN START ---');
    const identifier = (normalizedUsername || normalizedEmail);
    if (!identifier) {
      console.log('Login failed: Username or email is required');
      return res.status(400).json({
        success: false,
        message: 'Username or email is required'
      });
    }

    console.log('Searching by identifier (email or username):', identifier);
    user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { username: identifier }
      ]
    });

    if (!user) {
      console.log('Login failed: User not found in DB');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    console.log('User found in DB:', { 
        id: user._id, 
        email: user.email, 
        role: user.role, 
        isActive: user.isActive 
    });

    // Check access type
    const appType = (req.header('X-App-Type') || 'website').toLowerCase();
    const userAccessType = user.accessType || 'both';
    
    if (userAccessType !== 'both') {
      if (userAccessType === 'website' && appType === 'mobile') {
        return res.status(403).json({
          success: false,
          message: 'Access denied. This account is only allowed on website.'
        });
      }
      if (userAccessType === 'mobile' && appType === 'website') {
        return res.status(403).json({
          success: false,
          message: 'Access denied. This account is only allowed on mobile app.'
        });
      }
    }

    // Run password verification, tenant lookup, and forms fetching concurrently
    const tenantPromise = (user.role !== 'superadmin' && user.tenantId)
      ? (tenantSlug ? Tenant.findOne({ slug: tenantSlug }).lean() : Tenant.findById(user.tenantId).lean())
      : Promise.resolve(null);
      
    const formsPromise = (user.role !== 'superadmin' && user.tenantId)
      ? Form.find({ tenantId: user.tenantId, isGlobal: false })
          .select('id _id title category isGlobal parentFormId childForms tenantId status isActive createdAt')
          .sort({ createdAt: -1 })
          .limit(50)
          .lean()
          .catch(() => [])
      : Promise.resolve([]);

    const [isPasswordValid, tenantResult, formsResult] = await Promise.all([
      user.comparePassword(password),
      tenantPromise,
      formsPromise
    ]);

    if (!isPasswordValid) {
      console.log('Login failed: Invalid password');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    let tenant = tenantResult;
    if (user.role !== 'superadmin') {
      if (!tenant || !tenant.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Tenant has been deactivated. Please contact support.'
        });
      }

      if (tenantSlug && tenant._id.toString() !== user.tenantId.toString()) {
        return res.status(401).json({
          success: false,
          message: 'User does not belong to this tenant'
        });
      }

      if (tenant.subscription && tenant.subscription.plan === 'free') {
        const now = new Date();
        if (tenant.subscription.endDate && now > tenant.subscription.endDate) {
          return res.status(403).json({
            success: false,
            message: 'Your 30-day free trial has expired. please contact admin to get more details choose our upgrade plan',
            trialExpired: true
          });
        }
      }
    }

    // Generate token immediately
    const token = generateToken(user._id);

    // Get IP address for location lookup
    const ipAddress = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'];
    const sessionLogId = new mongoose.Types.ObjectId();

    // Async background logging (does not block user login response speed)
    setImmediate(async () => {
      try {
        user.lastLogin = new Date();
        await user.save();
      } catch (e) {
        console.error('Failed to update lastLogin:', e);
      }

      // Auto-assign shift based on login time
      try {
        if (user.role !== 'superadmin' && user.tenantId) {
          const toMins = (t) => {
            if (!t) return null;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m;
          };
          
          const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
          const currentMins = now.getHours() * 60 + now.getMinutes();
          
          const allShifts = await Shift.find({ tenantId: user.tenantId, isActive: true });
          
          const currentShift = allShifts.find(s => {
            const startMins = toMins(s.startTime);
            const endMins = toMins(s.endTime);
            const isNight = s.isNightShift || startMins > endMins;
            const bufferMins = 15;
            const bufferedStart = (startMins - bufferMins + 1440) % 1440;

            let isMatch = false;
            if (isNight) {
              if (bufferedStart > endMins) {
                isMatch = currentMins >= bufferedStart || currentMins < endMins;
              } else {
                isMatch = currentMins >= bufferedStart && currentMins < endMins;
              }
            } else {
              if (bufferedStart > endMins) {
                isMatch = currentMins >= bufferedStart || currentMins < endMins;
              } else {
                isMatch = currentMins >= bufferedStart && currentMins < endMins;
              }
            }
            return isMatch;
          });

          if (currentShift) {
            // Check if user is already in this shift
            const alreadyInShift = currentShift.assignedInspectors.some(
              id => id.toString() === user._id.toString()
            );
            
            if (!alreadyInShift) {
              // Remove user from all other shifts for this tenant
              await Shift.updateMany(
                { tenantId: user.tenantId },
                { $pull: { assignedInspectors: user._id } }
              );
              // Add user to the current active shift
              await Shift.updateOne(
                { _id: currentShift._id },
                { $addToSet: { assignedInspectors: user._id } }
              );
              console.log(`[Auto-Assign Shift] User ${user.username} assigned to ${currentShift.name}`);
            }
          }
        }
      } catch (shiftErr) {
        console.error('Failed to auto-assign shift:', shiftErr);
      }

      try {
        const enhancedLocation = await enhanceLocationData(location, ipAddress);
        await LoginLog.create({
          _id: sessionLogId,
          userId: user._id,
          tenantId: user.tenantId,
          location: enhancedLocation,
          ipAddress: ipAddress,
          userAgent: userAgent
        });
      } catch (logErr) {
        console.error('Failed to save login log:', logErr);
      }
    });

    const responseData = {
      token,
      sessionLogId,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
        lastLogin: user.lastLogin,
        permissions: [
          ...new Set([
            ...(user.permissions || []),
            ...(user.customRole?.permissions || [])
          ])
        ],
        granularPermissions: user.granularPermissions || {
          canEditAttendanceTime: false,
          canEditInvoices: false,
          canEditPricing: false
        }
      }
    };

    // Add tenant info for non-superadmin users (including admin)
    if (tenant) {
      responseData.tenant = {
        id: tenant._id,
        _id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        companyName: tenant.companyName,
        internalTrackingEnabled: tenant.internalTrackingEnabled,
        allowedTenantIds: tenant.allowedTenantIds,
        settings: tenant.settings,
        subscription: tenant.subscription
      };
      responseData.user.tenantId = tenant._id;
    }

    // Add prefetched dashboard data for instant frontend rendering
    if (formsResult && formsResult.length > 0) {
      responseData.initialData = {
        forms: formsResult
      };
    }

    res.json({
      success: true,
      message: 'Login successful',
      data: responseData
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error: error.message,
      stack: error.stack
    });
  }
};

export const getProfile = async (req, res) => {
  try {
    let tenantData = null;
    if (req.user.tenantId) {
      const tenant = await Tenant.findById(req.user.tenantId).select('name slug companyName internalTrackingEnabled allowedTenantIds settings subscription');
      if (tenant) {
        tenantData = {
          id: tenant._id,
          _id: tenant._id,
          name: tenant.name,
          slug: tenant.slug,
          companyName: tenant.companyName,
          internalTrackingEnabled: tenant.internalTrackingEnabled,
          allowedTenantIds: tenant.allowedTenantIds,
          settings: tenant.settings,
          subscription: tenant.subscription
        };
      }
    }
    // Include granularPermissions and combined customRole permissions in user profile
    const userWithPermissions = {
      ...req.user.toObject(),
      permissions: [
        ...new Set([
          ...(req.user.permissions || []),
          ...(req.user.customRole?.permissions || [])
        ])
      ],
      granularPermissions: req.user.granularPermissions || {
        canEditAttendanceTime: false,
        canEditInvoices: false,
        canEditPricing: false
      }
    };
    res.json({
      success: true,
      data: {
        user: userWithPermissions,
        ...(tenantData && { tenant: tenantData })
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    const user = await User.findById(req.user._id);

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const signup = async (req, res) => {
  try {
    const {
      name,
      slug,
      companyName,
      adminEmail,
      adminPassword,
      adminFirstName,
      adminLastName
    } = req.body;

    // Validate required fields
    if (!name || !slug || !companyName || !adminEmail || !adminPassword || !adminFirstName || !adminLastName) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    // Check if slug already exists
    const existingTenant = await Tenant.findOne({ slug: slug.toLowerCase() });
    if (existingTenant) {
      return res.status(400).json({
        success: false,
        message: 'Tenant slug already exists. Please choose a different slug.'
      });
    }

    // Check if admin email already exists
    const existingUser = await User.findOne({ email: adminEmail.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }

    // Calculate trial end date (30 days from now)
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + 30);

    // Create admin user
    const adminUser = new User({
      username: adminEmail.split('@')[0] + '-' + slug,
      email: adminEmail.toLowerCase(),
      password: adminPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      role: 'admin',
      isActive: true
    });

    // Create tenant
    const tenant = new Tenant({
      name,
      slug: slug.toLowerCase(),
      companyName,
      adminId: [adminUser._id],
      isActive: true,
      subscription: {
        plan: 'free',
        startDate,
        endDate,
        maxUsers: 10,
        maxForms: 5
      }
    });

    adminUser.tenantId = tenant._id;
    await adminUser.save();

    try {
      await tenant.save();
    } catch (error) {
      await User.findByIdAndDelete(adminUser._id);
      throw error;
    }

    res.status(201).json({
      success: true,
      message: 'Signup successful! Your 30-day free trial has started.',
      data: {
        tenant: {
          id: tenant._id,
          name: tenant.name,
          slug: tenant.slug,
          endDate: tenant.subscription.endDate
        }
      }
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

export const logout = async (req, res) => {
  try {
    const { sessionLogId } = req.body;

    // Update specific session if sessionLogId is provided
    if (sessionLogId) {
      await LoginLog.findByIdAndUpdate(sessionLogId, {
        logoutTime: new Date()
      });
    }

    // Get userId from authenticated user, or decode from expired token
    let userId = req.user?._id;
    if (!userId) {
      const authHeader = req.header('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const decoded = jwt.decode(token);
          if (decoded?.userId) {
            userId = decoded.userId;
          }
        } catch {}
      }
    }

    // Close ALL open sessions for this user
    if (userId) {
      await LoginLog.updateMany(
        { userId, logoutTime: null },
        { logoutTime: new Date() }
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * @desc    Request password reset via email (OTP sent to registered mobile)
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email - also get mobile number for OTP
    const user = await User.findOne({ email: normalizedEmail });

    // Security: Don't reveal if account exists - just say OTP was sent
    if (!user || !user.mobile) {
      return res.status(200).json({
        success: true,
        message: 'If the email exists and has a registered mobile number, an OTP has been sent',
        data: {
          success: true,
          message: 'OTP sent successfully'
        }
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry
    const verificationId = crypto.randomBytes(32).toString('hex');

    // Save OTP to database
    const newOtp = new Otp({
      email: normalizedEmail,
      otp,
      expiresAt,
      isVerified: false,
      verificationId,
      purpose: 'password-reset'
    });
    await newOtp.save();

    // Clean up any old OTPs for this email
    await Otp.deleteMany({
      email: normalizedEmail,
      _id: { $ne: newOtp._id },
      purpose: 'password-reset'
    });

    // Send OTP via SMS to registered mobile number
    // ✅ Use the imported smsService directly (no dynamic import)
    const smsResult = await smsService.sendOTP(user.mobile, otp);

    if (!smsResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP SMS',
        error: smsResult.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'Password reset OTP has been sent to your registered mobile number',
      data: {
        success: true,
        message: 'OTP sent successfully',
        verificationId,
        expiresAt,
        mobile: user.mobile
      }
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * @desc    Verify OTP for password reset
 * @route   POST /api/auth/verify-forgot-otp
 * @access  Public
 */
export const verifyForgotOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find OTP record
    const otpRecord = await Otp.findOne({
      email: normalizedEmail,
      otp: otp,
      isVerified: false
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    // Check expiration
    if (otpRecord.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: otpRecord._id });
      return res.status(400).json({
        success: false,
        message: 'OTP has expired'
      });
    }

    // Validate user exists
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Mark OTP as verified
    otpRecord.isVerified = true;
    const verificationId = crypto.randomBytes(32).toString('hex');
    otpRecord.verificationId = verificationId;
    await otpRecord.save();

    // Invalidate other OTPs
    await Otp.updateMany(
      { email: normalizedEmail, otp: { $ne: otp } },
      { isVerified: true }
    );

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        success: true,
        message: 'OTP verified successfully',
        verificationId,
        expiresAt: otpRecord.expiresAt,
        mobile: user.mobile
      }
    });
  } catch (error) {
    console.error('Verify forgot OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * @desc    Reset password after OTP verification
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
export const resetPassword = async (req, res) => {
  try {
    const { email, verificationId, newPassword } = req.body;

    if (!email || !verificationId || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, verification ID, and new password are required'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Password strength validation
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    // Find the verified OTP record with matching verification ID
    const otpRecord = await Otp.findOne({
      email: normalizedEmail,
      verificationId: verificationId,
      isVerified: true
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification session'
      });
    }

    // Verify OTP hasn't expired
    if (otpRecord.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: otpRecord._id });
      return res.status(400).json({
        success: false,
        message: 'Verification session has expired'
      });
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user password
    user.password = newPassword;
    await user.save();

    // Invalidate all existing sessions for this user
    await LoginLog.updateMany(
      { userId: user._id, logoutTime: null },
      { logoutTime: new Date() }
    );

    // Delete OTP records for this email after successful reset
    await Otp.deleteMany({ email: normalizedEmail });

    // Log password reset activity
    await LoginLog.create({
      userId: user._id,
      tenantId: user.tenantId,
      location: { status: 'password-reset' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(200).json({
      success: true,
      message: 'Password has been reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * @desc    Resend OTP for password reset (with rate limiting)
 * @route   POST /api/auth/resend-otp
 * @access  Public
 */
export const resendForgotOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const user = await User.findOne({ email: normalizedEmail });

    // Security: Don't reveal if email exists
    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If the email exists, a new OTP has been sent'
      });
    }

    if (!user.mobile) {
      return res.status(400).json({
        success: false,
        message: 'No mobile number registered for this account',
        error: 'No mobile number on file'
      });
    }

    // Rate limiting - check OTP resend attempts
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const recentOtps = await Otp.find({
      email: normalizedEmail,
      createdAt: { $gte: fiveMinutesAgo },
      purpose: 'password-reset'
    });

    if (recentOtps.length >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please wait 5 minutes before trying again.'
      });
    }

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const verificationId = crypto.randomBytes(32).toString('hex');

    const newOtp = new Otp({
      email: normalizedEmail,
      otp,
      expiresAt,
      isVerified: false,
      verificationId,
      purpose: 'password-reset'
    });
    await newOtp.save();

    // Invalidate previous unverified OTPs
    await Otp.updateMany(
      { 
        email: normalizedEmail, 
        otp: { $ne: otp },
        isVerified: false,
        purpose: 'password-reset'
      },
      { isVerified: true }
    );

    // Send OTP via SMS
    // ✅ Use the imported smsService directly
    const smsResult = await smsService.sendOTP(user.mobile, otp);

    if (!smsResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP SMS',
        error: smsResult.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'New OTP has been sent to your registered mobile number',
      data: {
        success: true,
        message: 'OTP resent successfully',
        verificationId,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};