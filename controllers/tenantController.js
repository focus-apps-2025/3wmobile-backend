import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import Form from '../models/Form.js';
import Response from '../models/Response.js';
import FormInvite from '../models/FormInvite.js';
import Parameter from '../models/Parameter.js';
import Profile from '../models/Profile.js';
import Settings from '../models/Settings.js';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

// Create a new tenant (SuperAdmin only)
export const createTenant = async (req, res) => {
  try {
    const { 
      name, 
      slug, 
      companyName, 
      adminEmail, 
      adminPassword,
      adminFirstName,
      adminLastName,
      adminMobile,
      settings,
      subscription,
      officeLocation
    } = req.body;

    // Validate required fields
    if (!name || !slug || !companyName || !adminEmail || !adminPassword || !adminFirstName || !adminLastName) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    // Check if slug already exists
    const existingTenant = await Tenant.findOne({ slug });
    if (existingTenant) {
      return res.status(400).json({
        success: false,
        message: 'Tenant slug already exists. Please choose a different slug.'
      });
    }

    // Check if admin email already exists
    const existingUser = await User.findOne({ email: adminEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Admin email already exists'
      });
    }

    // Prepare admin user and tenant documents with linked ids
    const adminUser = new User({
      username: adminEmail.split('@')[0] + '-' + slug,
      email: adminEmail,
      password: adminPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      mobile: adminMobile,
      role: 'admin',
      isActive: true,
      createdBy: req.user._id
    });

    const tenant = new Tenant({
      name,
      slug,
      companyName,
      adminId:[adminUser._id],
      isActive: true,
      settings: {
        ...(settings || {}),
        officeLocation: officeLocation || undefined
      },
      subscription: subscription || {},
      createdBy: req.user._id
    });

    // Assign tenant id to admin before persisting to satisfy schema requirements
    adminUser.tenantId = tenant._id;

    await adminUser.save();

    try {
      await tenant.save();
    } catch (error) {
      // Roll back admin user creation if tenant fails to persist
      await User.findByIdAndDelete(adminUser._id);
      throw error;
    }

    res.status(201).json({
      success: true,
      message: 'Tenant created successfully',
      data: {
        tenant,
        admin: {
          id: adminUser._id,
          email: adminUser.email,
          firstName: adminUser.firstName,
          lastName: adminUser.lastName
        }
      }
    });

  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get all tenants (SuperAdmin only)
export const getAllTenants = async (req, res) => {
  try {
    const { page = 1, limit = 1000, search = '', status = 'all', plan = 'all' } = req.query;

    const query = { ...req.tenantFilter };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } }
      ];
    }

    if (status !== 'all') {
      query.isActive = status === 'active';
    }

    if (plan !== 'all') {
      if (plan === 'paid') {
        query['subscription.plan'] = { $ne: 'free' };
      } else {
        query['subscription.plan'] = plan;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tenants, total] = await Promise.all([
      Tenant.find(query)
        .populate('createdBy', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Tenant.countDocuments(query)
    ]);

    // ONLY use User collection as source of truth for admins
    // Fetch both 'admin' and 'subadmin' roles for complete admin list
    const tenantsWithAllAdmins = await Promise.all(
      tenants.map(async (tenant) => {
        const allAdmins = await User.find({
          tenantId: tenant._id,
          role: { $in: ['admin', 'subadmin', 'inspector'] }
        }).select('_id firstName lastName email isActive lastLogin role granularPermissions createdAt').lean();
        
        return {
          ...tenant,
          adminId: allAdmins || [] // This will always show all admins, default to empty array
        };
      })
    );

    res.json({
      success: true,
      data: {
        tenants: tenantsWithAllAdmins,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get all tenants error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get minimal list of tenants for sharing/linking (any authenticated user)
export const getTenantsMinimal = async (req, res) => {
  try {
    const tenants = await Tenant.find({ isActive: true })
      .select('_id name companyName')
      .sort({ companyName: 1 })
      .lean();

    res.json({
      success: true,
      data: { tenants }
    });
  } catch (error) {
    console.error('Get minimal tenants error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update tenant
export const getTenantBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const tenant = await Tenant.findOne({ slug })
      .populate('adminId', 'firstName lastName email isActive lastLogin role granularPermissions')
      .lean();

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    res.json({
      success: true,
      data: { tenant }
    });

  } catch (error) {
    console.error('Get tenant by slug error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update tenant
export const updateTenant = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Don't allow updating slug or adminId directly
    delete updates.slug;
    delete updates.adminId;
    delete updates.createdBy;

    const tenant = await Tenant.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('adminId', 'firstName lastName email isActive granularPermissions');

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    res.json({
      success: true,
      message: 'Tenant updated successfully',
      data: { tenant }
    });

  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Toggle tenant active status
// Toggle tenant active status
export const toggleTenantStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findById(id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    tenant.isActive = !tenant.isActive;
    await tenant.save();

    // Update ALL admin/subadmin users status for this tenant
    await User.updateMany(
      { tenantId: tenant._id, role: { $in: ['admin', 'subadmin', 'inspector'] } },
      { isActive: tenant.isActive }
    );

    res.json({
      success: true,
      message: `Tenant ${tenant.isActive ? 'activated' : 'deactivated'} successfully`,
      data: { tenant }
    });

  } catch (error) {
    console.error('Toggle tenant status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Delete tenant (hard delete)
export const deleteTenant = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findById(id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Find all users of this tenant to delete their profiles
    const users = await User.find({ tenantId: id });
    const userIds = users.map(u => u._id);

    // Delete all associated data
    await Promise.all([
      Profile.deleteMany({ userId: { $in: userIds } }),
      User.deleteMany({ tenantId: id }),
      Form.deleteMany({ tenantId: id }),
      Response.deleteMany({ tenantId: id }),
      FormInvite.deleteMany({ tenantId: id }),
      Parameter.deleteMany({ tenantId: id }),
      Tenant.findByIdAndDelete(id)
    ]);

    res.json({
      success: true,
      message: 'Tenant and all associated data deleted successfully from database'
    });

  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get tenant statistics
export const getTenantStats = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findById(id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Import models dynamically to avoid circular dependencies
    const Form = (await import('../models/Form.js')).default;
    const Response = (await import('../models/Response.js')).default;

    const [userCount, formCount, responseCount] = await Promise.all([
      User.countDocuments({ tenantId: id }),
      Form.countDocuments({ tenantId: id }),
      Response.countDocuments({ tenantId: id })
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          users: userCount,
          forms: formCount,
          responses: responseCount,
          subscription: tenant.subscription
        }
      }
    });

  } catch (error) {
    console.error('Get tenant stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const addAdminToTenant = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { email, password, firstName, lastName, mobile } = req.body;
    const requestingUser = req.user;

    console.log("📥 Adding admin to tenant:", { tenantId, email, firstName, lastName });

    if (!tenantId || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    if (requestingUser.role !== 'superadmin' && requestingUser.tenantId.toString() !== tenantId) {
      return res.status(403).json({ 
        success: false, 
        message: "You can only manage admins in your own tenant" 
      });
    }

    // Check duplicate email
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email already exists" });
    }

    // Create admin user
    const adminUser = new User({
      username: email.split("@")[0] + "-" + tenant.slug,
      email: email.toLowerCase(),
      password: password,
      firstName: firstName,
      lastName: lastName,
      mobile: mobile,
      role: "admin",
      tenantId: tenantId,
      isActive: true,
      createdBy: req.user._id
    });

    await adminUser.save();
    console.log(" Admin user created:", adminUser._id);

    // ROBUST APPROACH: Handle schema mismatch gracefully
    try {
      // First try the normal approach
      await Tenant.findByIdAndUpdate(
        tenantId,
        { $push: { adminId: adminUser._id } }
      );
    } catch (schemaError) {
      console.log(" Schema mismatch detected, fixing...");
      
      // If schema error, fix the document first
      const currentTenant = await Tenant.findById(tenantId).lean();
      
      let fixedAdminIds = [];
      if (currentTenant.adminId) {
        if (Array.isArray(currentTenant.adminId)) {
          fixedAdminIds = [...currentTenant.adminId];
        } else {
          // Convert single ObjectId to array
          fixedAdminIds = [currentTenant.adminId];
        }
      }
      
      // Add the new admin
      fixedAdminIds.push(adminUser._id);
      
      // Update with fixed array
      await Tenant.findByIdAndUpdate(
        tenantId,
        { $set: { adminId: fixedAdminIds } }
      );
      
      //console.log(" Schema fixed and admin added");
    }

    //console.log(" Admin added to tenant successfully");

    // Fetch updated admin list
    const allAdmins = await User.find({
      tenantId: tenantId,
      role: 'admin'
    }).select('firstName lastName email isActive lastLogin role createdAt').lean();

    //console.log(`Tenant now has ${allAdmins.length} admins`);

    return res.status(201).json({
      success: true,
      message: "Admin added successfully",
      data: {
        admin: {
          _id: adminUser._id,
          firstName: adminUser.firstName,
          lastName: adminUser.lastName,
          email: adminUser.email,
          role: adminUser.role,
          isActive: adminUser.isActive
        },
        adminCount: allAdmins.length
      }
    });

  } catch (error) {
    console.error(" Add admin error:", error);
    
    res.status(500).json({ 
      success: false, 
      message: "Failed to add admin. Please try again.",
      error: error.message 
    });
  }
};

// Remove admin from tenant
export const removeAdminFromTenant = async (req, res) => {
  try {
    const { tenantId, adminId } = req.params;
    const requestingUser = req.user;

    console.log("🗑️ Removing admin from tenant:", { tenantId, adminId });

    if (!tenantId || !adminId) {
      return res.status(400).json({ success: false, message: "Tenant ID and Admin ID are required" });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    if (requestingUser.role !== 'superadmin' && requestingUser.tenantId.toString() !== tenantId) {
      return res.status(403).json({ 
        success: false, 
        message: "You can only manage admins in your own tenant" 
      });
    }

    // Check if this is the last admin/subadmin
    const adminCount = await User.countDocuments({ 
      tenantId: tenantId, 
      role: { $in: ['admin', 'subadmin', 'inspector'] },
      isActive: true
    });

    if (adminCount <= 1) {
      return res.status(400).json({ 
        success: false, 
        message: "Cannot remove the last administrator from a tenant" 
      });
    }

    // Remove admin ID from tenant's adminId array
    await Tenant.findByIdAndUpdate(
      tenantId,
      { $pull: { adminId: adminId } }
    );

    // Deactivate the admin user (soft delete)
    await User.findByIdAndUpdate(adminId, {
      isActive: false
    });

    //console.log("✅ Admin removed from tenant");

    return res.json({
      success: true,
      message: "Admin removed successfully"
    });

  } catch (error) {
    console.error("❌ Remove admin error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error",
      error: error.message 
    });
  }
};

// Get global default logo (SuperAdmin only)
export const getGlobalDefaultLogo = async (req, res) => {
  try {
    const settings = await Settings.findOne({ settingType: 'global' });
    
    return res.json({
      success: true,
      data: {
        defaultLogo: settings?.defaultLogo || null
      }
    });
  } catch (error) {
    console.error("❌ Get global logo error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Update global default logo (SuperAdmin only)
export const updateGlobalDefaultLogo = async (req, res) => {
  try {
    const { defaultLogo } = req.body;

    if (!defaultLogo) {
      return res.status(400).json({
        success: false,
        message: 'Default logo is required'
      });
    }

    let settings = await Settings.findOne({ settingType: 'global' });

    if (!settings) {
      settings = new Settings({
        settingType: 'global',
        defaultLogo
      });
    } else {
      settings.defaultLogo = defaultLogo;
      settings.updatedAt = new Date();
    }

    await settings.save();

    return res.json({
      success: true,
      message: 'Global default logo updated successfully',
      data: {
        defaultLogo: settings.defaultLogo
      }
    });
  } catch (error) {
    console.error("❌ Update global logo error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Remove global default logo (SuperAdmin only)
export const removeGlobalDefaultLogo = async (req, res) => {
  try {
    const settings = await Settings.findOne({ settingType: 'global' });

    if (settings) {
      settings.defaultLogo = null;
      settings.updatedAt = new Date();
      await settings.save();
    }

    return res.json({
      success: true,
      message: 'Global default logo removed successfully'
    });
  } catch (error) {
    console.error("❌ Remove global logo error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// @desc    Get office location for current tenant
// @route   GET /api/tenants/office-location
// @access  Private (Admin only)
export const getOfficeLocation = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const tenant = await Tenant.findById(tenantId).select('settings.officeLocation');

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const officeLocation = tenant.settings?.officeLocation;
    const hasLocation = officeLocation && officeLocation.lat !== undefined && officeLocation.lat !== null && officeLocation.lng !== undefined && officeLocation.lng !== null;

    res.json({
      success: true,
      data: hasLocation ? officeLocation : null
    });
  } catch (error) {
    console.error('Error fetching office location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch office location'
    });
  }
};

// @desc    Update office location for current tenant
// @route   PUT /api/tenants/office-location
// @access  Private (Admin only)
export const updateOfficeLocation = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { lat, lng, radius } = req.body;

    console.log('Updating office location for tenant:', tenantId);
    console.log('Request data:', { lat, lng, radius });

    const updateData = {
      'settings.officeLocation': {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        radius: parseInt(radius) || 500
      }
    };

    console.log('Update data:', updateData);

    const tenant = await Tenant.findByIdAndUpdate(tenantId, updateData, { new: true });

    console.log('Updated tenant:', tenant?.settings?.officeLocation);

    if (!tenant) {
      console.error('Tenant not found after update');
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    res.json({
      success: true,
      message: 'Office location updated successfully',
      data: tenant.settings.officeLocation
    });

}
 catch (error) {
    console.error('Error updating office location:', error);
    res.status(500).json({
      success: false, message: 'Failed to update office location'
    });
  }
};