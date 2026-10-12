import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Role from '../models/Permission.js';

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('⚠️ JWT_SECRET not found in process.env, using default');
  }
  return secret || 'your-secret-key-change-in-production';
};

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const appType = (req.header('X-App-Type') || 'website').toLowerCase(); // 'website' or 'mobile'
    
    console.log('=== AUTH CHECK ===');
    console.log('X-App-Type header:', req.header('X-App-Type'));
    console.log('Using appType:', appType);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied. No token provided.' 
      });
    }

    const token = authHeader.substring(7);
    
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.userId)
      .select('-password')
      .populate('customRole');
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token. User not found.' 
      });
    }

    console.log('=== Access Type Check ===');
    console.log('User:', user.firstName, user.lastName);
    console.log('Role:', user.role);
    console.log('accessType field:', user.accessType);
    console.log('appType:', appType);

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account has been deactivated.' 
      });
    }

    // Check access type (only if explicitly set and not 'both')
    // Admins (admin, superadmin, subadmin) can access both platforms regardless of accessType
    const isAdmin = ['admin', 'superadmin', 'subadmin'].includes(user.role);
    const userAccessType = user.accessType || 'both';
    console.log('userAccessType:', userAccessType);
    console.log('isAdmin:', isAdmin);
    console.log('Should block?', !isAdmin && userAccessType !== 'both' && userAccessType === 'mobile' && appType === 'website');

    if (!isAdmin && userAccessType !== 'both') {
      if (userAccessType === 'website' && appType === 'mobile') {
        console.log('BLOCKING: mobile access tries website');
        return res.status(403).json({
          success: false,
          message: 'Access denied. This account is only allowed on website.'
        });
      }
      if (userAccessType === 'mobile' && appType === 'website') {
        console.log('BLOCKING: website access tries mobile');
        return res.status(403).json({
          success: false,
          message: 'Access denied. This account is only allowed on mobile app.'
        });
      }
    }

    user.lastLogin = new Date();
    await user.save().catch((err) => console.warn('Failed to update lastLogin:', err.message));

    console.log('authenticate - user logged in:', user.firstName, user.lastName, 'role:', user.role, 'tenantId:', user.tenantId, 'accessType:', user.accessType);
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ 
      success: false, 
      message: 'Invalid token.' 
    });
  }
};

export const authenticateOptional = async (req, res, next) => {
  const authHeader = req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.userId)
      .select('-password')
      .populate('customRole');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. User not found.'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated.'
      });
    }

    user.lastLogin = new Date();
    await user.save();

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid token.'
    });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied. Please authenticate first.' 
      });
    }

    if (!roles.includes(req.user.role)) {
      console.log('Authorization failed:', {
        userRole: req.user.role,
        allowedRoles: roles,
        path: req.path,
        method: req.method
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. Insufficient permissions. Your role: ${req.user.role}, Required roles: ${roles.join(', ')}`
      });
    }

    next();
  };
};

export const superAdminOnly = authorize('superadmin');
export const adminOnly = authorize('admin', 'superadmin', 'subadmin');
export const teacherOrAdmin = authorize('teacher', 'admin', 'superadmin');
export const staffOrAdmin = authorize('staff', 'admin', 'superadmin', 'subadmin', 'tenant_admin', 'manager');
export const inspectorOrAdmin = authorize('inspector', 'admin', 'superadmin', 'subadmin', 'tenant_admin', 'manager');

export const generateToken = (userId) => {
  return jwt.sign({ userId }, getJwtSecret(), { 
    expiresIn: process.env.JWT_EXPIRES_IN || '7d' 
  });
};

export const generateGuestToken = (email, formId) => {
  return jwt.sign({ guestEmail: email, formId, isGuest: true }, getJwtSecret(), { 
    expiresIn: '7d' 
  });
};

export const authenticateGuest = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return authenticate(req, res, next);
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, getJwtSecret());
    
    if (decoded.isGuest) {
      req.user = {
        email: decoded.guestEmail,
        role: 'guest',
        isGuest: true,
        accessibleFormId: decoded.formId
      };
      return next();
    }

    return authenticate(req, res, next);
  } catch (error) {
    console.error('Guest Authentication error:', error);
    return authenticate(req, res, next);
  }
};

export const hasPermission = (permission) => {
  return (req, res, next) => {
    const user = req.user;
    
    // SuperAdmin and Admin always have all permissions
    if (user.role === 'superadmin' || user.role === 'admin') {
      return next();
    }

    // Inspector role has view_all_responses, view_analytics, export_data permissions
    if (user.role === 'inspector') {
      const inspectorPermissions = ['view_all_responses', 'view_analytics', 'export_data'];
      if (inspectorPermissions.includes(permission)) {
        return next();
      }
    }

    // Subadmin has all permissions
    if (user.role === 'subadmin') {
      return next();
    }

    // Check custom role permissions
    if (user.customRole && user.customRole.permissions.includes(permission)) {
      return next();
    }

    // Check user-specific permissions
    if (user.permissions && user.permissions.includes(permission)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Access denied. Required permission: ${permission}`
    });
  };
};

export const canAccessForm = async (req, res, next) => {
  try {
    const { id: formId } = req.params;
    const user = req.user;

    // SuperAdmin can access all forms
    if (user.role === 'superadmin') {
      return next();
    }

    // Inspector can access all forms within their tenant
    if (user.role === 'inspector' || user.role === 'subadmin') {
      return next();
    }

    // Check if user created the form
    const Form = (await import('../models/Form.js')).default;
    const form = await Form.findOne({ id: formId });

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Admin can access forms within their tenant
    if (user.role === 'admin' && form.tenantId.toString() === user.tenantId.toString()) {
      return next();
    }

    // Check if the tenant has any chassis assignments for this form
    const hasChassisAssignment = Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.some(
      assignment => assignment.assignedTenants && assignment.assignedTenants.includes(user.tenantId.toString())
    );
    if (hasChassisAssignment) {
      return next();
    }

    if (form.createdBy.toString() === user._id.toString()) {
      return next();
    }

    // Check role-based permissions for this form
    if (user.customRole && user.customRole.formPermissions) {
      const formPermission = user.customRole.formPermissions.find(
        fp => fp.formId === formId
      );
      
      if (formPermission) {
        req.formPermissions = formPermission.permissions;
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      message: 'Access denied. You do not have permission to access this form.'
    });

  } catch (error) {
    console.error('Form access check error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Check granular permission for admin actions
 * SuperAdmin always has access; Admin needs specific granular permission
 */
export const checkGranularPermission = (permissionType) => {
  return async (req, res, next) => {
    const user = req.user;
    
    // SuperAdmin always has all granular permissions
    if (user.role === 'superadmin') {
      return next();
    }
    
    // Admin needs to check granularPermissions
    if (user.role === 'admin') {
      const hasPermission = user.granularPermissions?.[permissionType] === true;
      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Admin does not have "${permissionType}" permission. Contact SuperAdmin to grant this permission.`
        });
      }
      return next();
    }
    
    // Other roles don't have granular permissions
    return res.status(403).json({
      success: false,
      message: 'Access denied. Only SuperAdmin and Admin can perform this action.'
    });
  };
};