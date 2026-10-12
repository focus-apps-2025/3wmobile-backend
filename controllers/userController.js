import User from '../models/User.js';
import Review from '../models/Review.js';
import LoginLog from '../models/LoginLog.js';

// ─── Date Parser Helper ──────────────────────────────────────────────────────
const parseDateUTC = (dateStr) => {
  if (!dateStr) return null;

  // Handle YYYY-MM-DD format
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  // Handle DD-MM-YYYY or DD/MM/YYYY format
  const parts = dateStr.split(/[-/]/);
  if (parts.length === 3) {
    let year, month, day;
    if (parts[2].length === 4) { // DD-MM-YYYY
      year = parts[2];
      month = parts[1];
      day = parts[0];
    } else if (parts[0].length === 4) { // YYYY-MM-DD
      year = parts[0];
      month = parts[1];
      day = parts[2];
    }

    if (year && month && day) {
      return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`);
    }
  }

  return null;
};

// Permission validator - accepts static leaf keys and dynamic analytics form keys
const isValidPermissionKey = (permission) => {
  // Static permission keys (including new analytics global actions)
  const staticPermissions = new Set([
    'dashboard:view',
    'Overall:view',
    'admin:manage',
    'chat',
    'attendance:activityLogs',
    'attendance:record:report',
    'attendance:record:response',
    'attendance:record:calendar',
    'attendance:record:summary',
    'hr:leaves',
    'hr:permission',
    'hr:shifts',
    'hr:reports',
    // New analytics global actions
    'analytics:downloadTemplate',
    'analytics:importExcel',
    'analytics:createService',
    'analytics:manageForms',
    'analytics:editForms',
    'analytics:duplicateForms',
    'analytics:deleteForms',
    'analytics:manage',
    'analytics:edit',
    'analytics:duplicate',
    'analytics:delete',
    // Customer requests & analytics legacy keys
    'analytics:view',
    'requests:view',
    'requests:manage',
    'requests:dashboard',
    'requests:response',
  ]);

  // Check if it's a static permission
  if (staticPermissions.has(permission)) {
    return true;
  }

  // Check if it's a dynamic analytics form permission
  // Pattern: analytics:form:<formId>:<subType> or analytics:form:<formId>
  const analyticsFormPattern = /^analytics:form:[a-zA-Z0-9_-]+:(preview|response|dashboard|overall|questions|sections|edit|duplicate|delete|uploads)$/;
  const analyticsFormParentPattern = /^analytics:form:[a-zA-Z0-9_-]+$/;
  if (analyticsFormPattern.test(permission) || analyticsFormParentPattern.test(permission)) {
    return true;
  }

  // Check if it's the analytics parent (should not be stored directly)
  const parentPermissions = new Set([
    'analytics',
    'analytics:form',
    'requests',
    'attendance',
    'attendance:record',
    'hr'
  ]);
  
  // Reject if it's a parent permission
  if (parentPermissions.has(permission)) {
    return false;
  }

  return false;
};
import mongoose from 'mongoose';

export const createUser = async (req, res) => {
  try {
    const { username, email, password, firstName, lastName, role, mobile, permissions, accessType, customRole } = req.body;

    if (req.user.role === 'admin' && role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admins cannot create additional admin accounts'
      });
    }

    // Check if username already exists globally
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({
        success: false,
        message: 'Username is already taken'
      });
    }

    // Check if email already exists globally
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        message: 'Email is already registered'
      });
    }

    const sanitizedPermissions = Array.isArray(permissions)
      ? Array.from(new Set(permissions.filter((permission) => isValidPermissionKey(permission))))
      : [];

    // Create new user
    const newUserData = {
      username,
      email,
      password,
      firstName,
      lastName,
      role,
      mobile,
      createdBy: req.user._id,
      tenantId: req.user.role === 'superadmin' ? req.body.tenantId : req.user.tenantId,
      customRole: customRole || undefined
    };

    // Add accessType for inspector role
    if (role === 'inspector' && accessType) {
      newUserData.accessType = accessType;
    }

    if (role === 'subadmin' || role === 'inspector') {
      newUserData.permissions = sanitizedPermissions;
    } else if (sanitizedPermissions.length > 0) {
      newUserData.permissions = sanitizedPermissions;
    }

    const newUser = new User(newUserData);

    await newUser.save();
    await newUser.populate('customRole');

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        user: newUser
      }
    });

  } catch (error) {
    console.error('Create user error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'User with this username or email already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, role, search } = req.query;

    const query = { ...req.tenantFilter };

    // Filter by role if provided
    if (role && role !== 'all') {
      query.role = role;
    }

    // Search by username, email, firstName, or lastName
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } }
      ];
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: {
        path: 'createdBy',
        select: 'username firstName lastName'
      }
    };

    const users = await User.find(query)
      .populate(options.populate.path, options.populate.select)
      .populate('customRole')
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit)
      .lean();

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalUsers: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({ _id: id, ...req.tenantFilter })
      .populate('createdBy', 'username firstName lastName')
      .populate('customRole');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: {
        user
      }
    });

  } catch (error) {
    console.error('Get user by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, firstName, lastName, role, isActive, permissions, accessType, customRole } = req.body;

    const user = await User.findOne({ _id: id, ...req.tenantFilter });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update accessType if provided (only for inspector role)
    if (accessType && user.role === 'inspector') {
      user.accessType = accessType;
    }

    if (role && req.user.role !== 'superadmin' && role === 'admin' && req.user._id.toString() !== user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can assign admin role'
      });
    }

    // Check if username or email already exists (excluding current user)
    if (username || email) {
      const existingUser = await User.findOne({
        _id: { $ne: id },
        $or: [
          ...(username ? [{ username }] : []),
          ...(email ? [{ email }] : [])
        ],
        ...req.tenantFilter
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this username or email already exists'
        });
      }
    }

    let sanitizedPermissions;
    if (permissions !== undefined) {
      if (!Array.isArray(permissions) || !permissions.every((permission) => typeof permission === 'string')) {
        return res.status(400).json({
          success: false,
          message: 'Permissions must be an array of strings'
        });
      }
      sanitizedPermissions = Array.from(new Set(permissions.filter((permission) => isValidPermissionKey(permission))));
    }

    // Update user fields
    if (username) user.username = username;
    if (email) user.email = email;
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (role) user.role = role;
    if (typeof isActive === 'boolean') user.isActive = isActive;
    if (sanitizedPermissions !== undefined) user.permissions = sanitizedPermissions;
    if (customRole !== undefined) user.customRole = customRole || null;

    await user.save();
    await user.populate('customRole');

    res.json({
      success: true,
      message: 'User updated successfully',
      data: {
        user
      }
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({ _id: id, ...req.tenantFilter });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deletion of admin/subadmin users
    if (user.role === 'admin' || user.role === 'subadmin') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete admin users. Use removeAdminFromTenant endpoint instead.'
      });
    }

    await User.findOneAndDelete({ _id: id, ...req.tenantFilter });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const requestingUser = req.user;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    const user = await User.findOne({ _id: id, ...req.tenantFilter });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userEmail = user.email;
    const userRole = user.role;
    const isSuperAdminReset = requestingUser.role === 'superadmin';

    if (isSuperAdminReset) {
      console.log(`🔐 SuperAdmin (${requestingUser.email}) resetting password for ${userRole} (${userEmail})`);
    } else {
      console.log(`🔐 Admin (${requestingUser.email}) resetting password for user (${userEmail})`);
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully',
      data: {
        userId: user._id,
        email: user.email,
        role: user.role,
        resetBy: isSuperAdminReset ? 'superadmin' : 'admin'
      }
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
export const getAvailableAdmins = async (req, res) => {
  try {
    const { tenantId, role } = req.query;

    const query = {
      ...req.tenantFilter,
      isActive: true
    };

    if (tenantId) {
      query.tenantId = tenantId;
    }

    if (role) {
      // Handle comma-separated roles like "admin,subadmin"
      const roles = role.split(',');
      query.role = { $in: roles };
    } else {
      query.role = { $in: ['admin', 'subadmin'] };
    }

    const users = await User.find(query)
      .select('_id firstName lastName email role')
      .sort({ firstName: 1 });

    res.json({
      success: true,
      data: {
        users
      }
    });
  } catch (error) {
    console.error('Get available admins error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUserActivityLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, search, startDate, endDate } = req.query;

    let userQuery = {};
    if (req.user.role === 'admin') {
      // Admin sees their subadmins and themselves
      const subAdmins = await User.find({ createdBy: req.user._id }).select('_id');
      const allowedUserIds = [req.user._id, ...subAdmins.map(u => u._id)];
      userQuery.userId = { $in: allowedUserIds };
    } else if (req.user.role !== 'superadmin') {
      userQuery.userId = req.user._id;
    }

    // Default tenant filtering
    if (req.tenantFilter && req.tenantFilter.tenantId) {
      userQuery.tenantId = req.tenantFilter.tenantId;
    }

    if (startDate && endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      userQuery.loginTime = {
        $gte: new Date(startDate),
        $lte: end
      };
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { loginTime: -1 }
    };

    const logs = await LoginLog.find(userQuery)
      .populate('userId', 'username firstName lastName email role')
      .populate('tenantId', 'name')
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await LoginLog.countDocuments(userQuery);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalLogs: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get user activity logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUsersHierarchy = async (req, res) => {
  try {
    const query = { ...req.tenantFilter };

    if (req.user.role === 'admin') {
      const subadmins = await User.find({ createdBy: req.user._id })
        .select('-password').sort({ createdAt: -1 });
      return res.json({
        success: true,
        data: { users: subadmins }
      });
    }

    // Superadmin: We want to return Admins and their Subadmins
    // Either a tree structure or list with populated createdBy
    const users = await User.find(query)
      .populate('createdBy', 'username firstName lastName email role')
      .populate('tenantId', 'name')
      .select('-password')
      .sort({ role: 1, createdAt: -1 });

    res.json({
      success: true,
      data: {
        users
      }
    });
  } catch (error) {
    console.error('Get users hierarchy error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @route   GET /api/users/all-tenants-performance
// @desc    Get all admin users across all tenants with performance metrics (SuperAdmin only)
// @access  Private (SuperAdmin only)
export const getAllTenantsPerformance = async (req, res) => {
  try {
    // Only superadmin can access this
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. SuperAdmin only.'
      });
    }

    const { startDate, endDate, search, role, page = 1, limit = 50 } = req.query;

    // ─── UTC Date Parser Helper ─────────────────────────────────────────
    const parseDateUTC = (dateStr) => {
      if (!dateStr) return null;

      // Handle YYYY-MM-DD format
      if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return new Date(`${dateStr}T00:00:00.000Z`);
      }

      // Handle DD-MM-YYYY or DD/MM/YYYY format
      const parts = dateStr.split(/[-/]/);
      if (parts.length === 3) {
        let year, month, day;
        if (parts[2].length === 4) { // DD-MM-YYYY
          year = parts[2];
          month = parts[1];
          day = parts[0];
        } else if (parts[0].length === 4) { // YYYY-MM-DD
          year = parts[0];
          month = parts[1];
          day = parts[2];
        }

        if (year && month && day) {
          return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`);
        }
      }

      return null;
    };

    // Build query to get all admins/subadmins across all tenants
    const query = {
      role: { $in: ['admin', 'subadmin', 'inspector'] }
    };

    // Search filter
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      ];
    }

    // Role filter
    if (role && role !== 'all') {
      query.role = role;
    }

    // Fetch users with tenant info
    const users = await User.find(query)
      .populate('tenantId', 'name companyName slug')
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(query);

    // For each user, get performance metrics
    const Response = (await import('../models/Response.js')).default;
    const LoginLogModel = (await import('../models/LoginLog.js')).default;

    // ─── Date Handling with UTC ─────────────────────────────────────────
    const parsedStart = startDate ? parseDateUTC(startDate) : null;
    const parsedEnd = endDate ? parseDateUTC(endDate) : null;

    // Create UTC dates with proper boundaries
    let start = parsedStart;
    let end = parsedEnd;

    if (!start) {
      // Default to 30 days ago
      const defaultStart = new Date();
      defaultStart.setMonth(defaultStart.getMonth() - 1);
      start = new Date(Date.UTC(
        defaultStart.getUTCFullYear(),
        defaultStart.getUTCMonth(),
        defaultStart.getUTCDate(),
        0, 0, 0, 0
      ));
    } else {
      // Ensure start is at beginning of day UTC
      start = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
        0, 0, 0, 0
      ));
    }

    if (!end) {
      // Default to today
      const defaultEnd = new Date();
      end = new Date(Date.UTC(
        defaultEnd.getUTCFullYear(),
        defaultEnd.getUTCMonth(),
        defaultEnd.getUTCDate(),
        23, 59, 59, 999
      ));
    } else {
      // Ensure end is at end of day UTC
      end = new Date(Date.UTC(
        end.getUTCFullYear(),
        end.getUTCMonth(),
        end.getUTCDate(),
        23, 59, 59, 999
      ));
    }

    console.log('=== Date Debug (UTC) ===');
    console.log('startDate:', startDate, 'parsed start:', start.toISOString());
    console.log('endDate:', endDate, 'parsed end:', end.toISOString());

    const performanceData = await Promise.all(users.map(async (user) => {
      const tenantId = user.tenantId?._id || user.tenantId;
      const userEmail = user.email?.toLowerCase();

      // Get form submissions count
      const formsSubmitted = await Response.countDocuments({
        $or: [
          { submittedBy: user.username },
          { "submitterContact.email": userEmail }
        ],
        tenantId,
        createdAt: { $gte: start, $lte: end }
      });

      // Get personally submitted forms
      const personallySubmitted = await Response.countDocuments({
        $or: [
          { submittedBy: user.username },
          { "submitterContact.email": userEmail }
        ],
        tenantId,
        createdAt: { $gte: start, $lte: end }
      });

      // Get active hours from ActivityLog
      const ActivityLog = (await import('../models/ActivityLog.js')).default;

      const activities = await ActivityLog.find({
        userId: user._id,
        tenantId: tenantId,
        createdAt: { $gte: start, $lte: end }
      }).sort({ createdAt: 1 }).lean();

      // Calculate active minutes using session timeout logic (30 min timeout)
      const SESSION_TIMEOUT = 30 * 60 * 1000;
      let activeMinutes = 0;
      if (activities.length > 0) {
        let sessionStart = activities[0].createdAt;
        let lastActivity = activities[0].createdAt;
        console.log(`Session start: ${sessionStart.toISOString()}`);

        for (let i = 1; i < activities.length; i++) {
          const current = activities[i].createdAt;
          const gap = current - lastActivity;
          console.log(`Gap: ${gap / 1000 / 60} minutes`);
          if (gap <= SESSION_TIMEOUT) {
            lastActivity = current;
          } else {
            const sessionMinutes = Math.ceil((lastActivity - sessionStart) / 60000);
            console.log(`Session ended, adding ${Math.max(sessionMinutes, 2)} minutes`);
            activeMinutes += Math.max(sessionMinutes, 2);
            sessionStart = current;
            lastActivity = current;
          }
        }
        const lastSessionMinutes = Math.ceil((lastActivity - sessionStart) / 60000);
        console.log(`Last session adding ${Math.max(lastSessionMinutes, 2)} minutes`);
        activeMinutes += Math.max(lastSessionMinutes, 2);
      }
      console.log(`Total active minutes for ${user.username}: ${activeMinutes}`);
      const activeHours = activeMinutes / 60;

      // Get last login and logout times
      const lastSession = await LoginLogModel.findOne({
        userId: user._id,
        loginTime: { $gte: start, $lte: end }
      }).sort({ loginTime: -1 });

      return {
        userId: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
        tenantId: tenantId,
        tenantName: user.tenantId?.companyName || user.tenantId?.name || 'N/A',
        tenantSlug: user.tenantId?.slug || 'N/A',
        metrics: {
          formsSubmitted,
          personallySubmitted,
          activeHours: Math.round(activeHours * 10) / 10,
          activeDurationMinutes: activeMinutes,
          lastActive: lastSession?.loginTime || null,
          lastLogin: lastSession?.loginTime || null,
          lastLogout: lastSession?.logoutTime || null
        }
      };
    }));

    res.json({
      success: true,
      data: {
        users: performanceData,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalUsers: total,
          hasNextPage: page < Math.ceil(total / limit),
          hasPrevPage: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get all tenants performance error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get all performance scores
// @route   GET /api/users/performance-scores
// @access  Public (authenticated users can see scores)
export const getPerformanceScores = async (req, res) => {
  try {
    console.log('Fetching performance scores...');

    // Get users - apply tenant filter if user is authenticated
    const tenantFilter = req.tenantFilter || {};
    const users = await User.find(tenantFilter).select('_id performanceScore email firstName lastName');
    console.log(`Found ${users.length} users with tenant filter:`, tenantFilter);

    // Convert to {userId: score, email: score, username: score} format for easier frontend lookup
    const scores = {};
    users.forEach(user => {
      const score = user.performanceScore || 0;
      scores[user._id.toString()] = score;
      if (user.email) {
        scores[user.email] = score; // Also map by email
      }
      if (user.username) {
        scores[user.username] = score; // Also map by username
      }
    });

    console.log('Returning performance scores:', Object.keys(scores).length, 'entries');

    res.json({
      success: true,
      data: scores
    });
  } catch (error) {
    console.error('Error fetching performance scores:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch performance scores'
    });
  }
};

// @desc    Submit a review and update performance score
// @route   POST /api/users/reviews
// @access  Private (Admin only)
// userController.js - submitReview
export const submitReview = async (req, res) => {
  try {
    let { responseId, reviewerId, submitterId, reviewOption, tenantId } = req.body;

    console.log('[submitReview] Received request:', {
      responseId,
      reviewerId,
      submitterId,
      reviewOption,
      tenantId
    });

    // Validate required fields
    if (!responseId || !reviewerId || !submitterId || !reviewOption || !tenantId) {
      console.log('[submitReview] Missing fields');
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Validate review option
    if (!['Accepted', 'Rejected', 'Rework'].includes(reviewOption)) {
      console.log('[submitReview] Invalid review option:', reviewOption);
      return res.status(400).json({
        success: false,
        message: 'Invalid review option'
      });
    }

    // Get reviewer info
    const reviewer = await User.findById(reviewerId).select('firstName lastName username email');
    console.log('[submitReview] Reviewer found:', reviewer ? 'Yes' : 'No');

    if (!reviewer) {
      return res.status(404).json({
        success: false,
        message: 'Reviewer not found'
      });
    }

    let reviewerName = '';
    if (reviewer.firstName || reviewer.lastName) {
      reviewerName = `${reviewer.firstName || ''} ${reviewer.lastName || ''}`.trim();
    }
    if (!reviewerName && reviewer.username) reviewerName = reviewer.username;
    if (!reviewerName && reviewer.email) reviewerName = reviewer.email;
    if (!reviewerName) reviewerName = 'Unknown Reviewer';

    // Resolve submitter ID - try to find user by email/username if it's not an ObjectId
    let resolvedSubmitterId = submitterId;
    if (!mongoose.Types.ObjectId.isValid(submitterId)) {
      const user = await User.findOne({
        $or: [
          { email: submitterId.toLowerCase() },
          { username: submitterId },
          { firstName: submitterId.split(' ')[0] }
        ]
      });
      if (user) {
        resolvedSubmitterId = user._id.toString();
        console.log('[submitReview] Resolved submitter ID:', resolvedSubmitterId);
      } else {
        console.log('[submitReview] Could not resolve submitter ID, keeping as:', submitterId);
      }
    }

    // Check if review already exists
    const existingReview = await Review.findOne({ responseId, reviewerId });
    if (existingReview) {
      console.log('[submitReview] Review already exists');
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this response'
      });
    }

    // Create review record
    const review = new Review({
      responseId,
      reviewerId,
      reviewerName: reviewerName,
      reviewerEmail: reviewer.email || '',
      submitterId: resolvedSubmitterId,
      reviewOption,
      scoreChange: 0, // No longer used for ratio formula
      tenantId
    });

    const savedReview = await review.save();
    console.log('[submitReview] Review saved successfully:', savedReview._id);

    // Only update performance score if submitterId is a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(resolvedSubmitterId)) {
      const user = await User.findById(resolvedSubmitterId);
      if (user) {
        // Increment total reviews
        const totalReviews = (user.totalReviews || 0) + 1;

        // Update specific counters
        let acceptedCount = user.acceptedCount || 0;
        let rejectedCount = user.rejectedCount || 0;
        let reworkCount = user.reworkCount || 0;

        if (reviewOption === 'Accepted') {
          acceptedCount += 1;
        } else if (reviewOption === 'Rejected') {
          rejectedCount += 1;
        } else if (reviewOption === 'Rework') {
          reworkCount += 1;
        }

        // Calculate performance score: (Accepted / Total) * 100
        const performanceScore = Math.round((acceptedCount / totalReviews) * 100);

        await User.findByIdAndUpdate(resolvedSubmitterId, {
          totalReviews,
          acceptedCount,
          rejectedCount,
          reworkCount,
          performanceScore
        });
        console.log('[submitReview] Updated user stats - Score:', performanceScore, 'Accepted:', acceptedCount, 'Total:', totalReviews);
      } else {
        console.log('[submitReview] User not found for ID:', resolvedSubmitterId);
      }
    } else {
      console.log('[submitReview] Skipping score update - submitterId is not a valid ObjectId:', resolvedSubmitterId);
    }

    res.json({
      success: true,
      message: 'Review submitted successfully',
      data: {
        review: {
          id: savedReview._id,
          reviewer: {
            id: reviewer._id,
            name: reviewerName,
            email: reviewer.email
          },
          option: reviewOption,
          scoreChange: 0
        }
      }
    });

  } catch (error) {
    console.error('[submitReview] ERROR:', error);
    console.error('[submitReview] Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to submit review',
      error: error.message
    });
  }
};

// @desc    Get reviews for a response
// @route   GET /api/responses/reviews/:responseId
// @access  Public (reviews should be viewable by response viewers)
// userController.js - getReviewsForResponse
// @desc    Update granular permissions for a user (SuperAdmin only)
// @route   PUT /api/users/:id/granular-permissions
// @access  Private (SuperAdmin only)
export const updateGranularPermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { canEditAttendanceTime, canEditInvoices, canEditPricing } = req.body;

    // Only superadmin can update granular permissions
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. SuperAdmin only.'
      });
    }

    const user = await User.findOne({ _id: id });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update granular permissions
    if (typeof canEditAttendanceTime === 'boolean') {
      user.granularPermissions.canEditAttendanceTime = canEditAttendanceTime;
    }
    if (typeof canEditInvoices === 'boolean') {
      user.granularPermissions.canEditInvoices = canEditInvoices;
    }
    if (typeof canEditPricing === 'boolean') {
      user.granularPermissions.canEditPricing = canEditPricing;
    }

    await user.save();

    res.json({
      success: true,
      message: 'Granular permissions updated successfully',
      data: {
        user: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          granularPermissions: user.granularPermissions
        }
      }
    });

  } catch (error) {
    console.error('Update granular permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getReviewsForResponse = async (req, res) => {
  try {
    const { responseId } = req.params;

    console.log(`[getReviewsForResponse] Fetching reviews for response: ${responseId}`);

    // Import models
    const Response = mongoose.model('Response');
    const Review = mongoose.model('Review');

    // Optional: Check if response exists (don't block if not found)
    try {
      const query = mongoose.Types.ObjectId.isValid(responseId)
        ? { $or: [{ _id: responseId }, { id: responseId }] }
        : { id: responseId };
      const response = await Response.findOne(query);
      if (!response) {
        console.log(`[getReviewsForResponse] Response not found: ${responseId}`);
        // Return empty reviews instead of error
        return res.json({
          success: true,
          reviews: []
        });
      }
    } catch (err) {
      console.log(`[getReviewsForResponse] Error finding response:`, err.message);
      // Continue anyway
    }

    // Fetch reviews - no user check needed, reviews are public
    const reviews = await Review.find({ responseId }).sort({ createdAt: -1 });
    console.log(`[getReviewsForResponse] Found ${reviews.length} reviews`);

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      reviewer: {
        id: review.reviewerId,
        name: review.reviewerName || 'Unknown',
        email: review.reviewerEmail || ''
      },
      option: review.reviewOption,
      scoreChange: review.scoreChange,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      reviews: formattedReviews
    });

  } catch (error) {
    console.error('[getReviewsForResponse] ERROR:', error);
    // Return empty reviews instead of 500 error
    res.json({
      success: true,
      reviews: []
    });
  }
};

export const getBulkReviewsForResponses = async (req, res) => {
  try {
    const { responseIds } = req.body;

    if (!Array.isArray(responseIds) || responseIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const Review = mongoose.model('Review');
    const reviews = await Review.find({ responseId: { $in: responseIds } }).sort({ createdAt: -1 }).lean();

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      responseId: review.responseId,
      reviewer: {
        id: review.reviewerId,
        name: review.reviewerName || 'Unknown',
        email: review.reviewerEmail || ''
      },
      option: review.reviewOption,
      scoreChange: review.scoreChange,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      data: formattedReviews
    });
  } catch (error) {
    console.error('[getBulkReviewsForResponses] ERROR:', error);
    res.json({
      success: true,
      data: []
    });
  }
};