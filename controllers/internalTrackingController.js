import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { superAdminOnly, adminOnly } from '../middleware/auth.js';

const toStr = (id) => {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (id.$oid) return id.$oid;
  if (id.toString) return id.toString();
  return String(id);
};

export const updateInternalTrackingSettings = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { internalTrackingEnabled, allowedTenantIds } = req.body;

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const updateData = {};

    if (typeof internalTrackingEnabled === 'boolean') {
      updateData.internalTrackingEnabled = internalTrackingEnabled;
    }

    if (Array.isArray(allowedTenantIds)) {
      const validTenantIds = allowedTenantIds
        .filter(id => typeof id === 'string' && id.length > 0)
        .map(id => {
          try { return new mongoose.Types.ObjectId(id); }
          catch { return null; }
        })
        .filter(Boolean);
      updateData.allowedTenantIds = validTenantIds;
    }

    const updatedTenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).lean();

    res.json({
      success: true,
      message: 'Internal tracking settings updated successfully',
      data: {
        tenant: {
          ...updatedTenant,
          _id: toStr(updatedTenant._id),
          allowedTenantIds: (updatedTenant.allowedTenantIds || []).map(toStr).filter(Boolean),
        }
      }
    });
  } catch (error) {
    console.error('Update internal tracking settings error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getInternalTrackingSettings = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const requestingUser = req.user;

    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    if (requestingUser.role !== 'superadmin' && requestingUser.tenantId.toString() !== tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    res.json({
      success: true,
      data: {
        tenantId: toStr(tenant._id),
        internalTrackingEnabled: tenant.internalTrackingEnabled || false,
        allowedTenantIds: (tenant.allowedTenantIds || []).map(toStr).filter(Boolean),
      }
    });
  } catch (error) {
    console.error('Get internal tracking settings error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const checkInternalTrackingAccess = async (req, res) => {
  try {
    const user = req.user;

    if (user.role === 'superadmin') {
      return res.json({ success: true, data: { hasAccess: true, isSuperAdmin: true } });
    }

    if (!user.tenantId) {
      return res.json({ success: true, data: { hasAccess: false, isSuperAdmin: false } });
    }

    const tenant = await Tenant.findById(user.tenantId).lean();
    if (!tenant) {
      return res.json({ success: true, data: { hasAccess: false, isSuperAdmin: false } });
    }

    const hasAccess =
      tenant.internalTrackingEnabled === true &&
      Array.isArray(tenant.allowedTenantIds) &&
      tenant.allowedTenantIds.length > 0;

    res.json({
      success: true,
      data: {
        hasAccess,
        isSuperAdmin: false,
        allowedTenantIds: (tenant.allowedTenantIds || []).map(toStr).filter(Boolean),
      }
    });
  } catch (error) {
    console.error('Check internal tracking access error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getInternalTrackingPerformance = async (req, res) => {
  try {
    const user = req.user;

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'name';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    if (user.role === 'superadmin') {
      const searchFilter = search ? {
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { companyName: { $regex: search, $options: 'i' } },
          { slug: { $regex: search, $options: 'i' } }
        ]
      } : {};

      const totalTenants = await Tenant.countDocuments({
        isActive: true,
        ...searchFilter
      });

      const tenants = await Tenant.find({
        isActive: true,
        ...searchFilter
      })
        .select('_id name companyName slug internalTrackingEnabled allowedTenantIds')
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean();

      const tenantIds = tenants.map(t => t._id);
      const users = await User.find({
        tenantId: { $in: tenantIds },
        role: { $in: ['admin', 'subadmin', 'inspector'] }
      })
        .select('_id tenantId role performanceScore firstName lastName email')
        .lean();

      const tenantPerformanceMap = {};
      users.forEach(u => {
        const tenantId = toStr(u.tenantId);
        if (!tenantPerformanceMap[tenantId]) {
          tenantPerformanceMap[tenantId] = { total: 0, count: 0 };
        }
        tenantPerformanceMap[tenantId].total += (u.performanceScore || 0);
        tenantPerformanceMap[tenantId].count += 1;
      });

      const enrichedTenants = tenants.map(t => {
        const tId = toStr(t._id);
        const perf = tenantPerformanceMap[tId] || { total: 0, count: 0 };
        return {
          _id: tId,
          name: t.name,
          companyName: t.companyName,
          slug: t.slug,
          internalTrackingEnabled: t.internalTrackingEnabled || false,
          performanceScore: perf.count > 0 ? Math.round(perf.total / perf.count) : 0,
          userCount: perf.count,
        };
      });

      return res.json({
        success: true,
        data: {
          tenants: enrichedTenants,
          users: users.map(u => ({
            _id: toStr(u._id),
            tenantId: toStr(u.tenantId),
            role: u.role,
            performanceScore: u.performanceScore || 0,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
          })),
          pagination: {
            page,
            limit,
            total: totalTenants,
            totalPages: Math.ceil(totalTenants / limit),
            hasNextPage: page < Math.ceil(totalTenants / limit),
            hasPrevPage: page > 1,
          }
        }
      });
    }

    if (!user.tenantId) {
      return res.status(403).json({ success: false, message: 'No tenant associated with this user.' });
    }

    const currentTenant = await Tenant.findById(user.tenantId).lean();

    if (!currentTenant) {
      return res.status(403).json({ success: false, message: 'Tenant not found.' });
    }

    if (!currentTenant.internalTrackingEnabled) {
      return res.status(403).json({
        success: false,
        message: 'Internal tracking is not enabled for your tenant.'
      });
    }

    const rawAllowedIds = currentTenant.allowedTenantIds || [];

    if (rawAllowedIds.length === 0) {
      return res.json({
        success: true,
        data: {
          tenants: [],
          users: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          }
        }
      });
    }

    const targetObjectIds = rawAllowedIds.map(id => {
      try {
        const str = toStr(id);
        return str ? new mongoose.Types.ObjectId(str) : null;
      } catch (e) {
        console.warn('[InternalTracking] Bad ObjectId skipped:', id, e.message);
        return null;
      }
    }).filter(Boolean);

    const searchFilter = search ? {
      _id: { $in: targetObjectIds },
      isActive: true,
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } }
      ]
    } : {
      _id: { $in: targetObjectIds },
      isActive: true
    };

    const totalAllowedTenants = await Tenant.countDocuments(searchFilter);

    const targetTenants = await Tenant.find(searchFilter)
      .select('_id name companyName slug')
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean();

    const allowedTenantIds = targetTenants.map(t => t._id);

    const users = await User.find({
      tenantId: { $in: allowedTenantIds },
      role: { $in: ['admin', 'subadmin', 'inspector'] },
    })
      .select('_id tenantId role performanceScore firstName lastName email')
      .lean();

    const tenantPerfMap = {};
    users.forEach(u => {
      const tenantId = toStr(u.tenantId);
      if (!tenantPerfMap[tenantId]) {
        tenantPerfMap[tenantId] = { total: 0, count: 0 };
      }
      tenantPerfMap[tenantId].total += (u.performanceScore || 0);
      tenantPerfMap[tenantId].count += 1;
    });

    const enrichedAllowedTenants = targetTenants.map(t => {
      const tId = toStr(t._id);
      const perf = tenantPerfMap[tId] || { total: 0, count: 0 };
      return {
        _id: tId,
        name: t.name,
        companyName: t.companyName,
        slug: t.slug,
        performanceScore: perf.count > 0 ? Math.round(perf.total / perf.count) : 0,
        userCount: perf.count,
      };
    });

    res.json({
      success: true,
      data: {
        tenants: enrichedAllowedTenants,
        users: users.map(u => ({
          _id: toStr(u._id),
          tenantId: toStr(u.tenantId),
          role: u.role,
          performanceScore: u.performanceScore || 0,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
        })),
        pagination: {
          page,
          limit,
          total: totalAllowedTenants,
          totalPages: Math.ceil(totalAllowedTenants / limit),
          hasNextPage: page < Math.ceil(totalAllowedTenants / limit),
          hasPrevPage: page > 1,
        }
      }
    });
  } catch (error) {
    console.error('[InternalTracking] getInternalTrackingPerformance crashed:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const getTenantPerformanceDetails = async (req, res) => {
  try {
    const user = req.user;
    const { tenantId } = req.params;

    const targetTenant = await Tenant.findById(tenantId).lean();
    if (!targetTenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    if (user.role !== 'superadmin') {
      if (!user.tenantId) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      const currentTenant = await Tenant.findById(user.tenantId).lean();
      if (!currentTenant) {
        return res.status(403).json({ success: false, message: 'Tenant not found.' });
      }

      if (!currentTenant.internalTrackingEnabled) {
        return res.status(403).json({
          success: false,
          message: 'Internal tracking is not enabled for your tenant.'
        });
      }

      const allowedIds = (currentTenant.allowedTenantIds || []).map(toStr).filter(Boolean);
      if (!allowedIds.includes(toStr(tenantId))) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    const users = await User.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      role: { $in: ['admin', 'subadmin', 'inspector'] },
    })
      .select('_id tenantId role performanceScore firstName lastName email isActive')
      .lean();

    const usersWithScores = users.map(u => ({
      _id: toStr(u._id),
      tenantId: toStr(u.tenantId),
      role: u.role,
      performanceScore: u.performanceScore || 0,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      isActive: u.isActive !== false,
    }));

    const avgPerformance = usersWithScores.length > 0
      ? Math.round(usersWithScores.reduce((sum, u) => sum + u.performanceScore, 0) / usersWithScores.length)
      : 0;

    res.json({
      success: true,
      data: {
        tenant: {
          _id: toStr(targetTenant._id),
          name: targetTenant.name,
          companyName: targetTenant.companyName,
          slug: targetTenant.slug,
          performanceScore: avgPerformance,
          userCount: usersWithScores.length,
        },
        users: usersWithScores,
      }
    });
  } catch (error) {
    console.error('[InternalTracking] getTenantPerformanceDetails crashed:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
