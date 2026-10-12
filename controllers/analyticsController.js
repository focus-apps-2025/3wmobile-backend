import mongoose from 'mongoose';
import Form from '../models/Form.js';
import Response from '../models/Response.js';
import User from '../models/User.js';
import FormSession from '../models/FormSession.js';
import ActivityLog from '../models/ActivityLog.js';
import Tenant from '../models/Tenant.js';
import Shift from '../models/Shift.js';
import Review from '../models/Review.js';
import { calculateUserActiveMinutes } from './activityController.js';
import { appCache } from '../utils/cache.js';

// ─── Date Parser Helper ──────────────────────────────────────────────────────
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  // Try DD-MM-YYYY or DD/MM/YYYY
  const parts = dateStr.split(/[-/]/);
  if (parts.length === 3) {
    // If year is the first part (YYYY-MM-DD), it would have been caught by new Date() 
    // unless it's a weird format. Let's assume DD is parts[0] or parts[2].
    let y, m, d_part;
    if (parts[2].length === 4) { // DD-MM-YYYY
      y = parts[2]; m = parts[1]; d_part = parts[0];
    } else if (parts[0].length === 4) { // YYYY-MM-DD (already tried but just in case)
      y = parts[0]; m = parts[1]; d_part = parts[2];
    }

    if (y) {
      const isoStr = `${y}-${m.padStart(2, '0')}-${d_part.padStart(2, '0')}`;
      const d2 = new Date(isoStr);
      if (!isNaN(d2.getTime())) return d2;
    }
  }
  return null;
};

// ─── Active Hours Calculator - Session Based (Server Side) ───────────────────
const calculateActiveMinutes = (activities, adminData = null, dateRange = {}) => {
  const { start, end } = dateRange;
  const startTime = start instanceof Date ? start.getTime() : (parseDate(start)?.getTime() || 0);
  let inclusiveEndTime = end instanceof Date ? end.getTime() : (parseDate(end)?.getTime() || Infinity);

  if (inclusiveEndTime !== Infinity) {
    const e = new Date(inclusiveEndTime);
    if (e.getUTCHours() === 0 && e.getUTCMinutes() === 0) {
      e.setHours(23, 59, 59, 999);
      inclusiveEndTime = e.getTime();
    }
  }

  const allTimestamps = activities
    .map(a => new Date(a.verifiedAt || a.updatedAt || a.createdAt).getTime())
    .filter(t => !isNaN(t) && t >= startTime && t <= inclusiveEndTime)
    .sort((a, b) => a - b);

  if (allTimestamps.length === 0) return 0;

  let totalMinutes = 0;
  const days = {};

  allTimestamps.forEach(t => {
    try {
      const dayStr = new Date(t).toISOString().split('T')[0];
      if (!days[dayStr]) days[dayStr] = [];
      days[dayStr].push(t);
    } catch (e) { /* ignore invalid dates */ }
  });

  for (const day in days) {
    const ts = days[day];
    if (ts.length === 1) {
      totalMinutes += 1; // ✅ Changed from 2 to 1 minute for single action
    } else {
      const spanMs = ts[ts.length - 1] - ts[0];
      // Calculate actual minutes without buffer
      const actualMinutes = Math.ceil(spanMs / 60000);
      totalMinutes += Math.max(actualMinutes, 1); // ✅ Minimum 1 minute
    }
  }

  return totalMinutes;
};

export const getDashboardStats = async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate;

    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case '1y':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // Get basic counts with tenant filter
    // For forms, we also include global forms shared with this tenant
    let effectiveFormFilter = { ...req.tenantFilter };
    if (req.user.role !== 'superadmin' && req.user.tenantId) {
      const tenantId = req.user.tenantId instanceof mongoose.Types.ObjectId
        ? req.user.tenantId
        : new mongoose.Types.ObjectId(req.user.tenantId);

      effectiveFormFilter = {
        $or: [
          { tenantId: tenantId },
          { sharedWithTenants: tenantId },
          { "chassisTenantAssignments.assignedTenants": tenantId.toString() }
        ]
      };
    }

    // All of the following are independent reads (none depend on another's
    // result), so they run concurrently instead of as 10 sequential round
    // trips to Mongo - this was the single biggest latency source in this
    // handler.
    const [
      totalForms,
      totalResponses,
      totalUsers,
      publicForms,
      formsInPeriod,
      responsesInPeriod,
      statusDistribution,
      topForms,
      dailyResponses,
      recentForms,
      recentResponses,
    ] = await Promise.all([
      Form.countDocuments(effectiveFormFilter),
      Response.countDocuments(req.tenantFilter),
      User.countDocuments({ ...req.tenantFilter, role: { $ne: 'admin' } }),
      Form.countDocuments({ ...effectiveFormFilter, isVisible: true }),
      Form.countDocuments({
        ...effectiveFormFilter,
        createdAt: { $gte: startDate }
      }),
      Response.countDocuments({
        ...req.tenantFilter,
        createdAt: { $gte: startDate }
      }),
      Response.aggregate([
        { $match: req.tenantFilter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),
      Response.aggregate([
        { $match: req.tenantFilter },
        {
          $group: {
            _id: '$questionId',
            responseCount: { $sum: 1 }
          }
        },
        {
          $sort: { responseCount: -1 }
        },
        {
          $limit: 5
        },
        {
          $lookup: {
            from: 'forms',
            localField: '_id',
            foreignField: 'id',
            as: 'form'
          }
        },
        {
          $unwind: '$form'
        },
        {
          $project: {
            formId: '$_id',
            title: '$form.title',
            responseCount: 1
          }
        }
      ]),
      Response.aggregate([
        {
          $match: {
            ...req.tenantFilter,
            createdAt: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt'
              }
            },
            count: { $sum: 1 }
          }
        },
        {
          $sort: { '_id': 1 }
        }
      ]),
      Form.find(effectiveFormFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('createdBy', 'username firstName lastName')
        .select('id title description createdAt createdBy'),
      Response.find(req.tenantFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('assignedTo', 'username firstName lastName')
        .select('id questionId submittedBy status createdAt assignedTo'),
    ]);

    res.json({
      success: true,
      data: {
        overview: {
          totalForms,
          totalResponses,
          totalUsers,
          publicForms,
          formsInPeriod,
          responsesInPeriod
        },
        statusDistribution: statusDistribution.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        topForms,
        dailyResponses: dailyResponses.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        recentActivity: {
          forms: recentForms,
          responses: recentResponses.map(response => ({
            ...response.toObject(),
            answers: response.answers ? Object.fromEntries(response.answers) : {}
          }))
        },
        period
      }
    });

  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFormAnalytics = async (req, res) => {
  try {
    const { formId } = req.params;
    const { period = '30d' } = req.query;

    console.log('[getFormAnalytics] Looking for form with ID:', formId);
    // Verify form exists (support both id and _id)
    let form;
    if (mongoose.Types.ObjectId.isValid(formId)) {
      form = await Form.findById(formId);
      console.log('[getFormAnalytics] Found by findById:', !!form);
    } else {
      form = await Form.findOne({ id: formId });
      console.log('[getFormAnalytics] Found by findOne(id):', !!form);
    }

    if (!form) {
      console.log('[getFormAnalytics] Form not found in database');
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Tenant check: Ensure user has access to this form
    let isOwner = false;
    let isShared = false;
    let hasChassisShare = false;

    if (req.user.role !== 'superadmin' && !req.user.isGuest) {
      const userTenantId = req.user.tenantId instanceof mongoose.Types.ObjectId
        ? req.user.tenantId
        : new mongoose.Types.ObjectId(req.user.tenantId);

      isOwner = form.tenantId && form.tenantId.toString() === userTenantId.toString();
      isShared = form.sharedWithTenants && form.sharedWithTenants.some(t => t.toString() === userTenantId.toString());
      hasChassisShare = Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.some(
        a => a.assignedTenants && a.assignedTenants.includes(userTenantId.toString())
      );

      if (!isOwner && !isShared && !hasChassisShare) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to view analytics for this form.'
        });
      }
    } else if (req.user.isGuest) {
      // Guest already verified via guestAccessControl middleware
      isOwner = false;
    } else {
      isOwner = true; // Superadmin sees everything
    }

    // Calculate date range
    const now = new Date();
    let startDate;

    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // Get all responses for this form (not just period) 
    // If it's a chassis share, we need to bypass the tenantFilter and manually filter by chassis
    const baseQuery = {
      $or: [{ questionId: formId }, { questionId: form._id?.toString() }]
    };

    // If not owner/superadmin, and only have chassis share or regular share
    // We only need to bypass tenantFilter if we are NOT the owner.
    let responseQuery = { ...baseQuery };
    if (!isOwner && req.user.role !== 'superadmin') {
      // We can't use req.tenantFilter because the responses belong to the owner
    } else {
      responseQuery = { ...responseQuery, ...req.tenantFilter };
    }

    let allResponses = await Response.find(responseQuery)
      .sort({ createdAt: -1 })
      .populate('assignedTo', 'firstName lastName email')
      .lean();

    // Filter responses for chassis sharing if applicable
    if (!isOwner && req.user.role !== 'superadmin' && hasChassisShare && !isShared) {
      const userTenantIdStr = req.user.tenantId.toString();
      const myAssignedChassis = (form.chassisTenantAssignments || [])
        .filter(a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr))
        .map(a => a.chassisNumber)
        .filter(Boolean);

      if (myAssignedChassis.length > 0) {
        // Find the question ID that has type 'chassisNumber'
        const chassisQuestion = form.sections?.flatMap(s => s.questions || []).find(q => q.type === 'chassisNumber')
          || form.followUpQuestions?.find(q => q.type === 'chassisNumber');
        const chassisFieldId = chassisQuestion?.id || 'chassis_number';

        allResponses = allResponses.filter(r => {
          const rAnswers = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});
          // Specifically check for the detected chassis field ID or 'chassis_number' fallback
          return myAssignedChassis.includes(rAnswers[chassisFieldId] || rAnswers['chassis_number']);
        });
      } else {
        allResponses = [];
      }
    }

    // Filter responses for timeline (within period)
    const periodResponses = allResponses.filter(r => new Date(r.createdAt) >= startDate);

    // Basic metrics
    const totalResponses = allResponses.length;

    // Status distribution
    const statusDistribution = allResponses.reduce((acc, response) => {
      acc[response.status] = (acc[response.status] || 0) + 1;
      return acc;
    }, {});

    // Map status to frontend expected format
    const responseStats = {
      completed: statusDistribution.verified || 0,
      pending: statusDistribution.pending || 0,
      inProgress: statusDistribution.inProgress || 0
    };

    // Create timeline data (daily grouping within period)
    const timelineMap = periodResponses.reduce((acc, response) => {
      const date = new Date(response.createdAt).toISOString().split('T')[0];
      if (!acc[date]) {
        acc[date] = { date, count: 0, status: response.status };
      }
      acc[date].count++;
      return acc;
    }, {});

    const timeline = Object.values(timelineMap).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Recent responses (last 10)
    const recentResponses = allResponses.slice(0, 10).map(response => ({
      _id: response._id,
      status: response.status === 'verified' ? 'completed' :
        response.status === 'pending' ? 'pending' :
          response.status === 'inProgress' ? 'in-progress' : response.status,
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
      assignedTo: response.assignedTo ? {
        name: `${response.assignedTo.firstName} ${response.assignedTo.lastName}`,
        email: response.assignedTo.email
      } : null,
      data: response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers
    }));

    res.json({
      success: true,
      data: {
        form: {
          _id: form._id,
          title: form.title,
          description: form.description,
          createdAt: form.createdAt
        },
        totalResponses,
        responseStats,
        responses: recentResponses,
        timeline,
        questionInsights: {
          sections: form.sections || [],
          followUpQuestions: form.followUpQuestions || [],
          responses: allResponses.map((response) => ({
            id: response.id,
            questionId: response.questionId,
            answers:
              response.answers instanceof Map
                ? Object.fromEntries(response.answers)
                : response.answers,
            status: response.status,
            createdAt: response.createdAt,
          })),
        },
      },
    });

  } catch (error) {
    console.error('Get form analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUserAnalytics = async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate;

    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // User role distribution with tenant filter
    const roleDistribution = await User.aggregate([
      ...(req.tenantFilter.tenantId ? [{ $match: req.tenantFilter }] : []),
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      }
    ]);

    // New users in period
    const newUsers = await User.countDocuments({
      ...req.tenantFilter,
      createdAt: { $gte: startDate }
    });

    // Active users (users who logged in recently)
    const activeUsers = await User.countDocuments({
      ...req.tenantFilter,
      lastLogin: { $gte: startDate }
    });

    // User activity by day
    const dailyActivity = await User.aggregate([
      {
        $match: {
          ...req.tenantFilter,
          lastLogin: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$lastLogin'
            }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id': 1 }
      }
    ]);

    res.json({
      success: true,
      data: {
        metrics: {
          totalUsers: await User.countDocuments(req.tenantFilter),
          newUsers,
          activeUsers,
          period
        },
        roleDistribution: roleDistribution.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        dailyActivity: dailyActivity.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {})
      }
    });

  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const exportAnalytics = async (req, res) => {
  try {
    const { type = 'dashboard', period = '30d', formId } = req.query;

    let data;

    switch (type) {
      case 'dashboard':
        // Get dashboard analytics
        await getDashboardStats(req, {
          json: (result) => { data = result.data; }
        });
        break;

      case 'form':
        if (!formId) {
          return res.status(400).json({
            success: false,
            message: 'Form ID is required for form analytics export'
          });
        }
        // Get form analytics
        // We need to merge query formId into params for getFormAnalytics
        const originalParams = req.params;
        req.params = { ...req.params, formId };
        await getFormAnalytics(req, {
          json: (result) => { data = result.data; }
        });
        req.params = originalParams; // Restore params
        break;

      case 'users':
        // Get user analytics
        await getUserAnalytics(req, {
          json: (result) => { data = result.data; }
        });
        break;

      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid analytics type'
        });
    }

    const exportData = {
      type,
      period,
      exportedAt: new Date().toISOString(),
      data
    };

    const filename = `analytics_${type}_${period}.json`;
    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    const encodedFilename = encodeURIComponent(filename);

    res.json(exportData);

  } catch (error) {
    console.error('Export analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAdminPerformance = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { startDate, endDate } = req.query;

    const pipeline = [];

    // Base match for the user's tenant
    const match = { ...req.tenantFilter };

    // Standardized date objects for matching and range mapping
    const startD = parseDate(startDate);
    const endD = parseDate(endDate);

    if (startD || endD) {
      match.createdAt = {};
      if (startD) match.createdAt.$gte = startD;
      if (endD) {
        const d = new Date(endD);
        d.setHours(23, 59, 59, 999);
        match.createdAt.$lte = d;
      }
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      match.createdAt = { $gte: thirtyDaysAgo };
    }

    const admin = await User.findById(adminId);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    // 1. Get process metrics (forms they verified/rejected)
    // Here we consider "processed" as forms assigned to them and verified/rejected by them.
    const assignmentsMatch = {
      ...match,
      assignedTo: new mongoose.Types.ObjectId(adminId)
    };

    const processStats = await Response.aggregate([
      { $match: assignmentsMatch },
      {
        $group: {
          _id: null,
          totalFormsProcessed: { $sum: { $cond: [{ $in: ['$status', ['verified', 'rejected']] }, 1, 0] } },
          formsApproved: { $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] } },
          formsRejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          pendingForms: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          // Response time in MINUTES
          totalResponseTime: {
            $sum: {
              $cond: [
                { $and: [{ $in: ['$status', ['verified', 'rejected']] }, { $not: [{ $eq: ['$verifiedAt', null] }] }] },
                { $divide: [{ $subtract: ['$verifiedAt', { $ifNull: ['$assignedAt', '$createdAt'] }] }, 60000] },
                0
              ]
            }
          }
        }
      }
    ]);

    // 2. Count all responses this admin has touched:
    //    - Responses currently assigned to them (their active workload)
    //    - Responses they verified/processed (their completed work)
    const adminObjectId = mongoose.Types.ObjectId.isValid(adminId)
      ? new mongoose.Types.ObjectId(adminId)
      : null;

    if (!adminObjectId && adminId.length === 24) {
      // Fallback if it's 24 chars but not 'valid' ObjectId for some reason
      try {
        new mongoose.Types.ObjectId(adminId);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid admin ID format' });
      }
    }

    // Reuse the 'admin' variable fetched at line 607
    const adminName = admin ? `${admin.firstName} ${admin.lastName}` : null;
    const adminEmail = admin ? admin.email : null;

    const allAssignedForms = await Response.countDocuments({
      ...match,
      $or: [
        { assignedTo: adminObjectId },
        { verifiedBy: adminObjectId },
        { submittedBy: adminName },
        { "submitterContact.email": adminEmail }
      ].filter(cond => Object.values(cond)[0] !== null)
    });

    const stats = processStats[0] || {
      totalFormsProcessed: 0,
      formsApproved: 0,
      formsRejected: 0,
      pendingForms: 0,
      totalResponseTime: 0
    };

    const avgResponseTime = stats.totalFormsProcessed > 0 ? stats.totalResponseTime / stats.totalFormsProcessed : 0;

    // 3. New: Calculate active minutes server-side for the given period (High-Fidelity)
    const startDateObj = startDate ? new Date(startDate) : new Date(new Date().setMonth(new Date().getMonth() - 1));
    const endDateObj = endDate ? new Date(endDate) : new Date();
    if (endDate) endDateObj.setHours(23, 59, 59, 999);

    // Use the official helper for consistency
    const activeMinutes = await calculateUserActiveMinutes(
      adminId,
      req.user.tenantId,
      startDateObj,
      endDateObj
    );

    // Calculate session-based stats (Secondary metrics)
    const allLogs = await ActivityLog.find({
      userId: new mongoose.Types.ObjectId(adminId),
      tenantId: req.user.tenantId,
      createdAt: { $gte: startDateObj, $lte: endDateObj }
    }).sort({ createdAt: 1 }).lean();

    let sessionCount = 0;
    let totalSessionDurationMs = 0;
    const SESSION_TIMEOUT = 30 * 60 * 1000;

    if (allLogs.length > 0) {
      sessionCount = 1;
      let sessionStart = allLogs[0].createdAt;
      let lastActivity = allLogs[0].createdAt;

      for (let i = 1; i < allLogs.length; i++) {
        const current = allLogs[i].createdAt;
        if (current - lastActivity > SESSION_TIMEOUT) {
          totalSessionDurationMs += (lastActivity - sessionStart);
          sessionCount++;
          sessionStart = current;
        }
        lastActivity = current;
      }
      totalSessionDurationMs += (lastActivity - sessionStart);
    }

    const avgSessionDuration = sessionCount > 0
      ? Math.round((totalSessionDurationMs / 60000) / sessionCount)
      : 0;

    res.json({
      success: true,
      data: {
        totalFormsProcessed: stats.totalFormsProcessed,
        formsApproved: stats.formsApproved,
        formsRejected: stats.formsRejected,
        pendingForms: stats.pendingForms,
        formsSubmitted: allAssignedForms,
        averageResponseTime: avgResponseTime,
        lastActive: (allLogs.length > 0 ? allLogs[allLogs.length - 1].createdAt : admin.lastLogin) || admin.updatedAt,
        totalCustomersAssigned: stats.totalFormsProcessed + stats.pendingForms,
        activeDurationMinutes: activeMinutes,
        activeHours: activeMinutes / 60,
        sessionCount,
        avgSessionDuration
      }
    });

  } catch (error) {
    console.error('getAdminPerformance error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getAdminActivity = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { startDate, endDate, limit = 10 } = req.query;

    // Fetch admin email to track their direct submissions
    const adminUser = await User.findById(adminId).select('email').lean();
    const adminEmail = adminUser?.email;

    // Find responses where the admin ACTED (verified/rejected) OR SUBMITTED OR ASSIGNED
    const match = {
      ...req.tenantFilter,
      $or: [
        { verifiedBy: new mongoose.Types.ObjectId(adminId) }, // Reviews they performed
        { assignedTo: new mongoose.Types.ObjectId(adminId) }, // Assigned to them
      ]
    };

    if (adminEmail) {
      match.$or.push({ "submitterContact.email": adminEmail }); // Direct submissions
    }

    if (startDate || endDate) {
      match.$or = match.$or.map(cond => {
        // Apply date filter to the specific timestamp of each activity type
        return { ...cond };
      });

      // We'll filter the whole query by updatedAt/verifiedAt range for simplicity
      match.$or = match.$or.map(cond => {
        const dateFilter = {};
        if (startDate) dateFilter.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          dateFilter.$lte = end;
        }

        // Use a generic updatedAt check for date range since verifiedAt/createdAt 
        // will both be reflected in updatedAt
        return { ...cond, updatedAt: dateFilter };
      });
    }

    const recentResponses = await Response.find(match)
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Get form titles
    const formIds = [...new Set(recentResponses.map(r => r.questionId))];
    const forms = await Form.find(
      { $or: formIds.map(id => ({ id: id })) },
      { id: 1, title: 1 }
    ).lean();

    const formTitleMap = {};
    forms.forEach(form => {
      formTitleMap[form.id] = form.title;
    });

    // Enrich activities with FormSession data for precise timing
    const recentActivity = await Promise.all(recentResponses.map(async (r) => {
      let durationMinutes = 0;

      // NEW: Improved matching logic
      let session = null;
      const metaSessionId = r.submissionMetadata?.formSessionId;

      if (metaSessionId) {
        session = await FormSession.findOne({ sessionId: metaSessionId }).lean();
      }

      if (!session) {
        // Fallback to existing timestamp-based logic
        session = await FormSession.findOne({
          userId: new mongoose.Types.ObjectId(adminId),
          formId: r.questionId,
          // Match approximate time (within 1 hour of response creation)
          startedAt: {
            $lte: new Date(r.createdAt),
            $gte: new Date(new Date(r.createdAt).getTime() - 60 * 60 * 1000)
          }
        }).lean();
      }

      if (session) {
        let timeSpent = session.timeSpent;
        if (!timeSpent && session.startedAt) {
          const end = new Date(session.completedAt || session.lastActivityAt || session.updatedAt || r.createdAt);
          const start = new Date(session.startedAt);
          timeSpent = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
        }
        if (timeSpent) durationMinutes = Math.floor(timeSpent / 60);
      } else if (r.status !== 'pending') {
        // Fallback to estimation
        const end = new Date(r.verifiedAt || r.updatedAt);
        const start = new Date(r.assignedAt || r.createdAt);
        const diffMs = end.getTime() - start.getTime();
        if (diffMs > 0) durationMinutes = Math.floor(diffMs / 60000);
      }

      return {
        id: r.id || r._id.toString(),
        type: r.status === 'verified' ? 'approve' : r.status === 'rejected' ? 'reject' : 'review',
        formId: r.questionId,
        formName: formTitleMap[r.questionId] || 'Unknown Form',
        customerName: r.submittedBy || r.submitterContact?.email || 'Unknown Customer',
        timestamp: r.verifiedAt || r.updatedAt || r.createdAt,
        durationMinutes
      };
    }));

    res.json({
      success: true,
      data: {
        recent: recentActivity
      }
    });
  } catch (error) {
    console.error('getAdminActivity error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getTenantSubmissionStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const match = { ...req.tenantFilter };

    // Add date filtering if provided
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) {
        match.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    const totalForms = await Form.countDocuments({ ...req.tenantFilter });
    const totalSubmissions = await Response.countDocuments(match);

    // Group by WHO ACTUALLY SUBMITTED (submittedBy or submitterContact.email)
    const userWiseSubmissions = await Response.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            // Use submittedBy field if available, otherwise use email from submitterContact
            submittedBy: "$submittedBy",
            email: "$submitterContact.email"
          },
          count: { $sum: 1 },
          responses: {
            $push: {
              id: "$id",
              formId: "$questionId",
              submittedAt: "$createdAt",
              status: "$status"
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id.submittedBy", // This is the submitter's name/ID
          userEmail: "$_id.email",
          userName: {
            $cond: {
              if: {
                $and: [
                  { $ne: ["$_id.submittedBy", null] },
                  { $ne: ["$_id.submittedBy", ""] },
                  { $ne: ["$_id.submittedBy", "undefined"] }
                ]
              },
              then: "$_id.submittedBy",
              else: {
                $cond: {
                  if: { $ne: ["$_id.email", null] },
                  then: "$_id.email",
                  else: "Anonymous"
                }
              }
            }
          },
          count: 1,
          forms: { $slice: ["$responses", 10] } // Last 10 responses
        }
      },
      { $sort: { count: -1 } }
    ]);


    res.json({
      success: true,
      data: {
        totalForms,
        totalSubmissions,
        userWiseSubmissions
      }
    });
  } catch (error) {
    console.error('getTenantSubmissionStats error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};


const extractFollowUpTree = (forms) => {
  const result = {};

  forms.forEach(form => {
    const formKey = form.id || form._id.toString();
    const formFollowUpData = {
      formId: formKey,
      formTitle: form.title,
      mainQuestion: null,
      followUpTree: [] // [{questionText, triggeredBy, level, children:[]}]
    };

    if (!form.sections || form.sections.length === 0) {
      result[formKey] = formFollowUpData;
      return;
    }

    // Find main question (first question with options, no showWhen)
    let mainQuestion = null;
    for (const section of form.sections) {
      if (!section.questions) continue;
      mainQuestion = section.questions.find(q =>
        q.options && q.options.length > 0 && !q.showWhen
      );
      if (mainQuestion) break;
    }

    if (!mainQuestion) {
      result[formKey] = formFollowUpData;
      return;
    }

    formFollowUpData.mainQuestion = {
      id: mainQuestion.id,
      text: mainQuestion.text,
      options: mainQuestion.options || []
    };

    // Target options: anything that is NOT the first option (usually "Approved")
    // i.e. Rejected, Rework, No, etc.
    const triggerOptions = (mainQuestion.options || []).filter((_, idx) => idx > 0);

    // Build a flat map of ALL questions across all sections
    const allQuestionsMap = {};
    for (const section of form.sections) {
      for (const q of (section.questions || [])) {
        allQuestionsMap[q.id] = { ...q, _sectionId: section.id };
        // Also include nested followUpQuestions
        const processNested = (questions, parentId) => {
          (questions || []).forEach(fq => {
            allQuestionsMap[fq.id] = { ...fq, _parentId: parentId };
            processNested(fq.followUpQuestions, fq.id);
          });
        };
        processNested(q.followUpQuestions, q.id);
      }
    }

    // Also process form-level followUpQuestions
    (form.followUpQuestions || []).forEach(fq => {
      allQuestionsMap[fq.id] = { ...fq };
      const processNested = (questions, parentId) => {
        (questions || []).forEach(nested => {
          allQuestionsMap[nested.id] = { ...nested, _parentId: parentId };
          processNested(nested.followUpQuestions, nested.id);
        });
      };
      processNested(fq.followUpQuestions, fq.id);
    });

    // Recursively build tree for a given parentQuestionId + triggerValue
    const buildTree = (parentQuestionId, triggerValue, level) => {
      const children = [];

      Object.values(allQuestionsMap).forEach(q => {
        if (
          q.showWhen &&
          q.showWhen.questionId === parentQuestionId &&
          (
            q.showWhen.value === triggerValue ||
            (Array.isArray(q.showWhen.value) && q.showWhen.value.includes(triggerValue)) ||
            triggerValue === null // no trigger filter — include all
          )
        ) {
          const node = {
            id: q.id,
            text: q.text || q.id,
            type: q.type,
            options: q.options || [],
            triggeredBy: triggerValue,
            level,
            children: buildTree(q.id, null, level + 1) // nested follow-ups
          };
          children.push(node);
        }

        // Also check inline followUpQuestions on the parent
        const parentQ = allQuestionsMap[parentQuestionId];
        if (parentQ && Array.isArray(parentQ.followUpQuestions)) {
          parentQ.followUpQuestions.forEach(fq => {
            if (!children.find(c => c.id === fq.id)) {
              children.push({
                id: fq.id,
                text: fq.text || fq.id,
                type: fq.type,
                options: fq.options || [],
                triggeredBy: triggerValue,
                level,
                children: []
              });
            }
          });
        }
      });

      return children;
    };

    // Build tree per trigger option
    triggerOptions.forEach(option => {
      const tree = buildTree(mainQuestion.id, option, 1);
      if (tree.length > 0) {
        formFollowUpData.followUpTree.push({
          triggerOption: option,
          questions: tree
        });
      }
    });

    result[formKey] = formFollowUpData;
  });

  return result;
};
export const getAdminResponseDetails = async (req, res) => {
  try {
    const { adminId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(400).json({ success: false, message: 'Invalid admin ID' });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const admin = await User.findById(adminId).select('firstName lastName email');
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }
    const adminName = `${admin.firstName} ${admin.lastName}`;
    const adminEmail = admin.email;
    const { startDate, endDate } = req.query;
    const match = { ...req.tenantFilter };

    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    } else {
      // Default to last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      match.createdAt = { $gte: thirtyDaysAgo };
    }

    // Fetch all responses this admin has touched
    const responses = await Response.find({
      ...match,
      $or: [
        { assignedTo: adminObjectId },
        { verifiedBy: adminObjectId },
        { submittedBy: adminName },
        { "submitterContact.email": adminEmail }
      ]
    }).sort({ createdAt: -1 }).lean();

    const totalResponses = responses.length;

    // Status breakdown
    const statusBreakdown = { pending: 0, verified: 0, rejected: 0 };
    responses.forEach(r => {
      if (r.status === 'pending') statusBreakdown.pending++;
      else if (r.status === 'verified') statusBreakdown.verified++;
      else if (r.status === 'rejected') statusBreakdown.rejected++;
    });

    // ========== FIX: Only count MAIN QUESTION answers ==========
    const overallAnswerDistribution = {};
    const formMap = {};

    // Get all forms to identify main questions
    const formIds = [...new Set(responses.map(r => r.questionId))];
    const forms = await Form.find(
      { $or: [{ id: { $in: formIds } }, { _id: { $in: formIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }] },
      { id: 1, _id: 1, title: 1, sections: 1 }
    ).lean();

    // Create a map of formId -> main question ID and options
    const formMainQuestionMap = {};
    forms.forEach(form => {
      const formKey = form.id || form._id.toString();

      // Find the main question (first question in first section that has options)
      let mainQuestionId = null;
      let mainQuestionOptions = [];

      if (form.sections && form.sections.length > 0) {
        for (const section of form.sections) {
          if (section.questions && section.questions.length > 0) {
            // Find the first question that has options (main question)
            const mainQuestion = section.questions.find(q =>
              q.options && q.options.length > 0 && !q.showWhen
            );
            if (mainQuestion) {
              mainQuestionId = mainQuestion.id;
              mainQuestionOptions = mainQuestion.options;
              break;
            }
          }
        }
      }

      formMainQuestionMap[formKey] = {
        mainQuestionId,
        mainQuestionOptions,
        title: form.title
      };
    });

    // Get sessions for time tracking
    const sessions = await FormSession.find({
      tenantId: req.user.tenantId,
      status: { $in: ['completed', 'in-progress'] },
      startedAt: { $gte: startDate ? new Date(new Date(startDate).getTime() - 60 * 60 * 1000) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    }).lean();

    const sessionMap = {};
    sessions.forEach(s => {
      if (!sessionMap[s.formId]) sessionMap[s.formId] = [];
      if (s.status === 'in-progress' && (!s.timeSpent || s.timeSpent === 0)) {
        const end = s.completedAt || s.lastActivityAt || s.updatedAt || new Date();
        const start = s.startedAt;
        s.timeSpent = Math.max(1, Math.floor((new Date(end) - new Date(start)) / 1000));
      }
      sessionMap[s.formId].push(s);
    });

    responses.forEach(r => {
      const formId = r.questionId;
      const formKey = formId;
      const formInfo = formMainQuestionMap[formKey];

      // Only process if we have main question info
      if (!formInfo || !formInfo.mainQuestionId) {
        console.log(`No main question found for form: ${formId}`);
        return;
      }

      if (!formMap[formId]) {
        formMap[formId] = {
          formId,
          formTitle: formInfo.title || formId,
          answerDistribution: {},
          responseCount: 0,
          totalDuration: 0,
          durationCount: 0,
          avgTimeSpent: 0
        };
      }

      formMap[formId].responseCount++;

      // ========== ONLY process the MAIN QUESTION answer ==========
      const answers = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});

      // Get the answer for the main question only
      const mainAnswer = answers[formInfo.mainQuestionId];

      if (mainAnswer !== null && mainAnswer !== undefined) {
        const answerValue = String(mainAnswer).trim();

        // Count in overall distribution
        overallAnswerDistribution[answerValue] = (overallAnswerDistribution[answerValue] || 0) + 1;

        // Count in form-specific distribution
        formMap[formId].answerDistribution[answerValue] =
          (formMap[formId].answerDistribution[answerValue] || 0) + 1;
      }

      // Time tracking (keep existing logic)
      const formSessions = sessionMap[formId] || [];
      const metaSessionId = r.submissionMetadata?.formSessionId;
      let matchingSession = null;

      if (metaSessionId) {
        matchingSession = formSessions.find(s => s.sessionId === metaSessionId);
      }
      if (!matchingSession) {
        matchingSession = formSessions.find(s => {
          const sessionTime = new Date(s.completedAt || s.lastActivityAt || s.updatedAt).getTime();
          const responseTime = new Date(r.createdAt || r.timestamp).getTime();
          const timeDiff = Math.abs(sessionTime - responseTime);
          const isSameUser = s.userId && adminObjectId && s.userId.toString() === adminObjectId.toString();
          const isAdminSubmission = r.submittedBy === adminName || r.submitterContact?.email === adminEmail;
          if (isSameUser || isAdminSubmission) {
            return timeDiff < 60 * 1000;
          }
          return timeDiff < 10 * 1000;
        });
      }

      if (matchingSession && matchingSession.timeSpent > 0) {
        formMap[formId].totalDuration += matchingSession.timeSpent;
        formMap[formId].durationCount++;
      } else if (r.status !== 'pending' && r.verifiedBy && r.verifiedBy.toString() === adminObjectId.toString() && r.verifiedAt) {
        const start = r.assignedAt || r.createdAt;
        const diffSeconds = Math.floor((new Date(r.verifiedAt) - new Date(start)) / 1000);
        if (diffSeconds > 0) {
          formMap[formId].totalDuration += Math.min(diffSeconds, 1800);
          formMap[formId].durationCount++;
        }
      }
    });

    // Calculate average time for each form
    Object.keys(formMap).forEach(id => {
      const f = formMap[id];
      f.totalTimeSpent = f.totalDuration;
      if (f.durationCount === 0) {
        const globalSessions = sessionMap[id] || [];
        const completedSessions = globalSessions.filter(s => s.timeSpent > 0);
        if (completedSessions.length > 0) {
          const total = completedSessions.reduce((sum, s) => sum + s.timeSpent, 0);
          f.avgTimeSpent = Math.round(total / completedSessions.length);
        }
      } else {
        f.avgTimeSpent = Math.round(f.totalDuration / f.durationCount);
      }
    });

    // Sort by response count descending
    const formBreakdown = Object.values(formMap).sort((a, b) => b.responseCount - a.responseCount);
    const followUpAnswers = {};

    responses.forEach(r => {
      const formId = r.questionId;
      const formInfo = formMainQuestionMap[formId];
      if (!formInfo || !formInfo.mainQuestionId) return;

      const answers = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});
      const mainAnswer = answers[formInfo.mainQuestionId];
      if (!mainAnswer) return;

      const mainAnswerStr = String(mainAnswer).trim();

      // Only collect follow-up answers for non-first-option answers (Rejected/Rework etc.)
      const mainOptions = formInfo.mainQuestionOptions || [];
      const isNonApproved = mainOptions.indexOf(mainAnswerStr) > 0;
      if (!isNonApproved) return;

      if (!followUpAnswers[formId]) followUpAnswers[formId] = [];

      // Collect all answers for this response (excluding main question)
      const followUpData = {};
      Object.entries(answers).forEach(([questionId, value]) => {
        if (questionId !== formInfo.mainQuestionId) {
          followUpData[questionId] = value;
        }
      });

      followUpAnswers[formId].push({
        responseId: r._id.toString(),
        mainAnswer: mainAnswerStr,
        followUpData,
        submittedBy: r.submittedBy || r.submitterContact?.email || 'Unknown',
        createdAt: r.createdAt
      });
    });
    // Personal submissions (only count main question responses)
    const personalSubmissions = responses
      .filter(r => (r.submittedBy === adminName || r.submitterContact?.email === adminEmail))
      .slice(0, 10)
      .map(r => ({
        id: r._id.toString(),
        formTitle: formMainQuestionMap[r.questionId]?.title || r.questionId,
        submittedAt: r.createdAt,
        status: r.status
      }));

    // Return the updated response with ONLY main question answers
    const followUpTreeData = extractFollowUpTree(forms);

    res.json({
      success: true,
      data: {
        totalResponses,
        statusBreakdown,
        answerDistribution: overallAnswerDistribution,
        formBreakdown,
        followUpTree: followUpTreeData,
        personalSubmissions,
        followUpAnswers,
      }
    });

  } catch (error) {
    console.error('getAdminResponseDetails error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// SuperAdmin: Get response details for a specific tenant
export const getTenantResponseDetails = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { startDate, endDate } = req.query;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant ID is required' });
    }

    // Build date filter
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    // Get all responses for this tenant in the date range
    const responses = await Response.find({
      tenantId: tenantId,
      createdAt: { $gte: start, $lte: end }
    }).sort({ createdAt: -1 }).lean();

    const totalResponses = responses.length;

    // Status breakdown
    const statusBreakdown = { pending: 0, verified: 0, rejected: 0 };
    responses.forEach(r => {
      if (r.status === 'pending') statusBreakdown.pending++;
      else if (r.status === 'verified') statusBreakdown.verified++;
      else if (r.status === 'rejected') statusBreakdown.rejected++;
    });

    // Yes / No / N/A answer counts
    const yesNoNA = { yes: 0, no: 0, na: 0 };
    const formMap = {};

    // Get sessions for all users in this tenant
    const sessions = await FormSession.find({
      tenantId: tenantId,
      status: { $in: ['completed', 'in-progress'] },
      startedAt: { $gte: new Date(start.getTime() - 60 * 60 * 1000) }
    }).lean();

    const sessionMap = {};
    sessions.forEach(s => {
      if (!sessionMap[s.formId]) sessionMap[s.formId] = [];

      if (s.status === 'in-progress' && (!s.timeSpent || s.timeSpent === 0)) {
        const endTime = s.completedAt || s.lastActivityAt || s.updatedAt || new Date();
        const startTime = s.startedAt;
        s.timeSpent = Math.max(1, Math.floor((new Date(endTime) - new Date(startTime)) / 1000));
      }

      sessionMap[s.formId].push(s);
    });

    responses.forEach(r => {
      const formId = r.questionId;
      const formMainQuestionMap = {};
      const formKey = formId;
      const formInfo = formMainQuestionMap[formKey];

      // ✅ Always initialize formMap entry FIRST
      if (!formMap[formId]) {
        formMap[formId] = {
          formId,
          formTitle: formInfo?.title || formId,
          answerDistribution: {},
          responseCount: 0,
          totalDuration: 0,
          durationCount: 0,
          avgTimeSpent: 0
        };
      }

      // ✅ Always increment responseCount BEFORE early return
      formMap[formId].responseCount++;

      // Now safe to return early if no main question found
      if (!formInfo || !formInfo.mainQuestionId) {
        console.log(`No main question found for form: ${formId}`);
        return;
      }
      // Try to match with session for time tracking
      const formSessions = sessionMap[formId] || [];
      const metaSessionId = r.submissionMetadata?.formSessionId;

      let matchingSession = null;
      if (metaSessionId) {
        matchingSession = formSessions.find(s => s.sessionId === metaSessionId);
      }

      if (!matchingSession) {
        matchingSession = formSessions.find(s => {
          const sessionTime = new Date(s.completedAt || s.lastActivityAt || s.updatedAt).getTime();
          const responseTime = new Date(r.createdAt || r.timestamp).getTime();
          return Math.abs(sessionTime - responseTime) < 60 * 1000;
        });
      }

      let timeSpent = 0;

      // Try to get time from various sources
      if (matchingSession && matchingSession.timeSpent > 0) {
        timeSpent = matchingSession.timeSpent;
      } else if (r.timeSpent > 0) {
        // Use response's own timeSpent field
        timeSpent = r.timeSpent;
      } else if (r.startedAt && r.completedAt) {
        // Calculate from startedAt and completedAt
        timeSpent = Math.floor((new Date(r.completedAt) - new Date(r.startedAt)) / 1000);
      } else if (r.startedAt) {
        // If only startedAt exists, calculate until submission
        timeSpent = Math.floor((new Date(r.createdAt) - new Date(r.startedAt)) / 1000);
      }

      if (timeSpent > 0) {
        formMap[formId].totalDuration += timeSpent;
        formMap[formId].durationCount++;
      }

      // Process answers - handle various formats
      const answers = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});
      Object.values(answers).forEach(val => {
        if (val === null || val === undefined) return;
        const strVal = String(val).toLowerCase().trim();
        if (strVal === 'yes' || strVal === 'y' || strVal === 'true' || strVal === '1') {
          yesNoNA.yes++;
          formMap[formId].yes++;
        }
        else if (strVal === 'no' || strVal === 'n' || strVal === 'false' || strVal === '0') {
          yesNoNA.no++;
          formMap[formId].no++;
        }
        else if (strVal === 'n/a' || strVal === 'na' || strVal === 'n or na' || strVal === 'not applicable') {
          yesNoNA.na++;
          formMap[formId].na++;
        }
      });
    });

    // Calculate average time for each form
    Object.keys(formMap).forEach(id => {
      const f = formMap[id];
      f.totalTimeSpent = f.totalDuration;
      if (f.durationCount > 0) {
        f.avgTimeSpent = Math.round(f.totalDuration / f.durationCount);
      }
    });

    // Enrich form titles
    const formIds = Object.keys(formMap);
    if (formIds.length > 0) {
      const forms = await Form.find(
        { $or: [{ id: { $in: formIds } }, { _id: { $in: formIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }] },
        { id: 1, _id: 1, title: 1 }
      ).lean();

      forms.forEach(f => {
        const key = f.id || f._id.toString();
        if (formMap[key]) {
          formMap[key].formTitle = f.title || key;
        }
      });
    }

    // Sort by response count
    const formBreakdown = Object.values(formMap).sort((a, b) => b.responseCount - a.responseCount);

    res.json({
      success: true,
      data: {
        totalResponses,
        statusBreakdown,
        yesNoNA,
        formBreakdown
      }
    });
  } catch (error) {
    console.error('getTenantResponseDetails error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getResponseTimeAnalytics = async (req, res) => {
  try {
    const { formId } = req.params;
    const { startDate, endDate, groupBy = 'day' } = req.query;

    // Build match conditions
    const match = {
      questionId: formId,
      ...req.tenantFilter,
      isSectionSubmit: { $ne: true }
    };

    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    // Get responses with timing data
    const responses = await Response.find(match)
      .populate('assignedTo', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .lean();

    // Calculate time statistics
    const times = responses
      .map(r => r.submissionMetadata?.timeSpent)
      .filter(t => t > 0);

    const stats = {
      totalResponses: responses.length,
      responsesWithTiming: times.length,
      averageTime: times.length > 0
        ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        : 0,
      medianTime: times.length > 0
        ? calculateMedian(times)
        : 0,
      minTime: times.length > 0 ? Math.min(...times) : 0,
      maxTime: times.length > 0 ? Math.max(...times) : 0,
      timeDistribution: calculateTimeDistribution(times),
      byDay: groupResponsesByDay(responses, groupBy),
      byHour: groupResponsesByHour(responses)
    };

    // Get question-level timings from FormSession
    const sessions = await FormSession.find({
      formId: formId,
      status: 'completed',
      questionTimings: { $exists: true, $ne: [] }
    }).lean();

    const questionTimings = {};
    sessions.forEach(session => {
      if (session.questionTimings) {
        session.questionTimings.forEach(q => {
          if (!questionTimings[q.questionId]) {
            questionTimings[q.questionId] = {
              questionId: q.questionId,
              questionText: q.questionText,
              questionType: q.questionType,
              times: [],
              averageTime: 0,
              totalTime: 0,
              responseCount: 0
            };
          }
          if (q.timeSpent) {
            questionTimings[q.questionId].times.push(q.timeSpent);
            questionTimings[q.questionId].totalTime += q.timeSpent;
            questionTimings[q.questionId].responseCount++;
          }
        });
      }
    });

    // Calculate averages for questions
    Object.values(questionTimings).forEach(q => {
      q.averageTime = q.responseCount > 0
        ? Math.round(q.totalTime / q.responseCount)
        : 0;
      q.timeSpentSeconds = q.averageTime;
      q.timeSpentFormatted = formatTimeDuration(q.averageTime);
    });

    // Get fastest and slowest submissions
    const fastestSubmissions = [...responses]
      .filter(r => r.submissionMetadata?.timeSpent > 0)
      .sort((a, b) => (a.submissionMetadata?.timeSpent || 0) - (b.submissionMetadata?.timeSpent || 0))
      .slice(0, 5)
      .map(r => ({
        id: r.id,
        submittedBy: r.submittedBy,
        timeSpent: r.submissionMetadata?.timeSpent,
        timeSpentFormatted: formatTimeDuration(r.submissionMetadata?.timeSpent),
        createdAt: r.createdAt
      }));

    const slowestSubmissions = [...responses]
      .filter(r => r.submissionMetadata?.timeSpent > 0)
      .sort((a, b) => (b.submissionMetadata?.timeSpent || 0) - (a.submissionMetadata?.timeSpent || 0))
      .slice(0, 5)
      .map(r => ({
        id: r.id,
        submittedBy: r.submittedBy,
        timeSpent: r.submissionMetadata?.timeSpent,
        timeSpentFormatted: formatTimeDuration(r.submissionMetadata?.timeSpent),
        createdAt: r.createdAt
      }));

    res.json({
      success: true,
      data: {
        summary: stats,
        questionTimings: Object.values(questionTimings).sort((a, b) => b.averageTime - a.averageTime),
        fastestSubmissions,
        slowestSubmissions,
        recentResponses: responses.slice(0, 20).map(r => ({
          id: r.id,
          submittedBy: r.submittedBy,
          timeSpent: r.submissionMetadata?.timeSpent,
          timeSpentFormatted: formatTimeDuration(r.submissionMetadata?.timeSpent),
          createdAt: r.createdAt,
          status: r.status
        }))
      }
    });

  } catch (error) {
    console.error('Get response time analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
function calculateMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function calculateTimeDistribution(times) {
  if (times.length === 0) return {};

  const buckets = {
    '0-30s': 0,
    '30s-1m': 0,
    '1-2m': 0,
    '2-5m': 0,
    '5-10m': 0,
    '10-20m': 0,
    '20-30m': 0,
    '30m+': 0
  };

  times.forEach(time => {
    if (time <= 30) buckets['0-30s']++;
    else if (time <= 60) buckets['30s-1m']++;
    else if (time <= 120) buckets['1-2m']++;
    else if (time <= 300) buckets['2-5m']++;
    else if (time <= 600) buckets['5-10m']++;
    else if (time <= 1200) buckets['10-20m']++;
    else if (time <= 1800) buckets['20-30m']++;
    else buckets['30m+']++;
  });

  return buckets;
}

function groupResponsesByDay(responses, groupBy) {
  const grouped = {};

  responses.forEach(response => {
    const date = new Date(response.createdAt);
    let key;

    if (groupBy === 'hour') {
      key = `${date.toISOString().split('T')[0]} ${date.getHours()}:00`;
    } else if (groupBy === 'week') {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      key = weekStart.toISOString().split('T')[0];
    } else {
      key = date.toISOString().split('T')[0];
    }

    if (!grouped[key]) {
      grouped[key] = {
        date: key,
        count: 0,
        totalTime: 0,
        averageTime: 0,
        responses: []
      };
    }

    const timeSpent = response.submissionMetadata?.timeSpent || 0;
    grouped[key].count++;
    grouped[key].totalTime += timeSpent;
    grouped[key].responses.push(timeSpent);
  });

  // Calculate averages
  Object.values(grouped).forEach(day => {
    day.averageTime = day.count > 0 ? Math.round(day.totalTime / day.count) : 0;
    day.averageTimeFormatted = formatTimeDuration(day.averageTime);
    delete day.responses;
  });

  return Object.values(grouped).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function groupResponsesByHour(responses) {
  const hourly = {};

  for (let i = 0; i < 24; i++) {
    hourly[i] = { hour: i, count: 0, totalTime: 0, averageTime: 0 };
  }

  responses.forEach(response => {
    const hour = new Date(response.createdAt).getHours();
    const timeSpent = response.submissionMetadata?.timeSpent || 0;

    hourly[hour].count++;
    hourly[hour].totalTime += timeSpent;
  });

  // Calculate averages
  Object.values(hourly).forEach(h => {
    h.averageTime = h.count > 0 ? Math.round(h.totalTime / h.count) : 0;
    h.averageTimeFormatted = formatTimeDuration(h.averageTime);
  });

  return Object.values(hourly);
}

export const getInspectorSummary = async (req, res) => {
  try {
    const { role, _id: userId, tenantId: userTenantId } = req.user;
    const { startDate, endDate, formId, tenantId: queryTenantId } = req.query;

    let matchFilter = {};

    // Internal Tracking: Check for cross-tenant access first
    if (queryTenantId && queryTenantId !== userTenantId?.toString()) {
      let hasAccess = false;
      if (role === 'superadmin') {
        hasAccess = true;
      } else if (userTenantId) {
        const currentUserTenant = await Tenant.findById(userTenantId).lean();
        if (currentUserTenant && currentUserTenant.internalTrackingEnabled) {
          const allowedIds = (currentUserTenant.allowedTenantIds || []).map(id => id.toString());
          if (allowedIds.includes(queryTenantId)) {
            hasAccess = true;
          }
        }
      }

      if (hasAccess) {
        matchFilter = { tenantId: new mongoose.Types.ObjectId(queryTenantId) };
      } else {
        return res.status(403).json({ success: false, message: 'Access to this tenant is denied for Inspector Summary.' });
      }
    } else {
      // Default behavior if no tenantId is specified in query
      if (role === 'superadmin') {
        // No initial filter for superadmin, can see all
      } else if (role === 'admin' || role === 'subadmin') {
        matchFilter.tenantId = new mongoose.Types.ObjectId(userTenantId);
      } else if (role === 'inspector') {
        matchFilter.createdBy = new mongoose.Types.ObjectId(userId);
      } else {
        // Default for other roles if any
        matchFilter.tenantId = new mongoose.Types.ObjectId(userTenantId);
      }
    }

    if (formId) {
      matchFilter.questionId = formId;
    }

    // Date filtering - handle inclusive days
    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        const s = new Date(startDate);
        s.setHours(0, 0, 0, 0);
        matchFilter.createdAt.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        matchFilter.createdAt.$lte = e;
      }
    }

    // Fetch all relevant responses
    console.log('getInspectorSummary - matchFilter:', JSON.stringify(matchFilter, null, 2));
    const responses = await Response.find(matchFilter).sort({ createdAt: 1 }).lean();
    console.log(`getInspectorSummary - found: ${responses?.length || 0} responses`);

    if (!responses || responses.length === 0) {
      return res.json({ success: true, data: { summary: [], allStatuses: [] } });
    }

    // Get all unique form IDs from these responses
    const formIds = [...new Set(responses.map(r => r.questionId?.toString()).filter(Boolean))];
    const forms = await Form.find({
      $or: [
        { id: { $in: formIds } },
        { _id: { $in: formIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
      ]
    }).lean();

    // Create a map of formId -> chassisQuestionId
    const formChassisMap = {};
    forms.forEach(f => {
      let chassisId = null;
      // ✅ FIX: Use 'f' instead of 'form'
      if (f.sections) {
        for (const section of f.sections) {
          if (section.questions) {
            for (const q of section.questions) {
              if (
                q.type === 'chassis' ||
                q.type === 'chassisWithZone' ||
                q.type === 'chassisWithoutZone' ||
                q.type === 'zone-in' ||
                q.type === 'zone-out' ||
                q.text?.toLowerCase().includes('chassis') ||
                q.trackResponseRank === true ||
                q.trackResponseRank === 'true' ||
                q.trackResponseQuestion === true ||
                q.trackResponseQuestion === 'true'
              ) {
                chassisId = q.id;
                break;
              }
            }
          }
          if (chassisId) break;
        }
      }
      if (f.id) formChassisMap[f.id] = chassisId;
      if (f._id) formChassisMap[f._id.toString()] = chassisId;
    });

    console.log('🔄 [getInspectorSummary] formChassisMap:', formChassisMap);

    // Group responses by item (Chassis) for status calculation
    const itemGroups = {};
    responses.forEach(r => {
      const formId = r.questionId?.toString();
      const chassisId = formChassisMap[formId];
      let itemId = `unknown_${r._id}`;

      if (chassisId && r.answers) {
        const answersObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers;
        const answer = answersObj[chassisId];
        if (answer) {
          if (typeof answer === 'object') {
            itemId = `${formId}_${answer.chassisNumber || JSON.stringify(answer)}`;
          } else {
            itemId = `${formId}_${String(answer)}`;
          }
        }
      } else {
        itemId = `${formId}_untracked_${r._id}`;
      }

      if (!itemGroups[itemId]) itemGroups[itemId] = [];
      itemGroups[itemId].push(r);
    });

    // Calculate status for each response
    const calculatedStatuses = {};
    Object.values(itemGroups).forEach(group => {
      let reworkCount = 0;
      let hasBeenReworked = false;

      group.forEach((r, index) => {
        let isRework = false;
        let isAccepted = false;
        let isRejected = false;
        let foundStatus = null;

        const answersObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers;
        if (answersObj) {
          Object.values(answersObj).forEach(ans => {
            if (ans === null || ans === undefined) return;

            let s = '';
            if (typeof ans === 'object' && ans.status) {
              s = String(ans.status).trim();
            } else if (typeof ans === 'string') {
              s = ans.trim();
            }

            if (!s) return;
            const sl = s.toLowerCase();

            if (sl === 'rework' || sl === 'reworked' || sl.includes('re-rework')) {
              isRework = true;
            } else if (
              sl === 'accepted' ||
              sl === 'rework completed' ||
              sl === 'verified' ||
              sl === 'yes' ||
              sl === 'direct ok' ||
              sl === 'rework accepted'
            ) {
              isAccepted = true;
            } else if (sl === 'rejected' || sl === 'no') {
              isRejected = true;
            } else {
              foundStatus = s;
            }
          });
        }

        let finalStatus = 'Pending';
        if (isRejected) {
          finalStatus = 'Rejected';
        } else if (isRework) {
          reworkCount++;
          hasBeenReworked = true;
          finalStatus = 'Rework QC Pending';
        } else if (isAccepted) {
          if (index === 0 && !hasBeenReworked) {
            finalStatus = 'Direct Ok';
          } else {
            finalStatus = 'Rework QC Completed';
          }
        } else if (foundStatus) {
          finalStatus = foundStatus;
        }

        calculatedStatuses[r._id.toString()] = finalStatus;
      });
    });

    // Now aggregate per inspector and date
    const inspectorData = {};
    for (const r of responses) {
      const creatorId = r.createdBy?.toString();
      if (!creatorId) continue;

      // Extract date string YYYY-MM-DD in IST (Asia/Kolkata)
      const d = new Date(r.createdAt);
      // Adjust to IST manually to be safe
      const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
      const dateIST = istDate.toISOString().split('T')[0];
      const formId = r.questionId?.toString() || 'unknown';
      const key = `${creatorId}_${dateIST}_${formId}`;

      if (!inspectorData[key]) {
        inspectorData[key] = {
          userId: creatorId,
          date: dateIST,
          formId: formId,
          tenantId: r.tenantId,
          totalInspection: 0,
          statusCounts: {
            'Direct Ok': 0,
            'Rework QC Completed': 0,
            'Rework QC Pending': 0,
            'Rejected': 0,
            'Dispatched': 0
          }
        };
      }

      const stats = inspectorData[key];
      const status = calculatedStatuses[r._id.toString()];
      stats.totalInspection++;

      if (stats.statusCounts.hasOwnProperty(status)) {
        stats.statusCounts[status]++;
      } else {
        stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
      }

      // Increment Dispatched count separately if it's dispatched
      if (r.isDispatched) {
        stats.statusCounts['Dispatched']++;
      }
    }

    // Join with User, Tenant, and Shift details
    const finalSummary = [];
    const entryKeys = Object.keys(inspectorData);
    const userIds = [...new Set(entryKeys.map(k => inspectorData[k].userId))];
    const formIdsToFetch = [...new Set(entryKeys.map(k => inspectorData[k].formId))].filter(id => id !== 'unknown');

    const users = await User.find({ _id: { $in: userIds } }).lean();
    const fetchedForms = await Form.find({
      $or: [
        { id: { $in: formIdsToFetch } },
        { _id: { $in: formIdsToFetch.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
      ]
    }).lean();

    const tenantIds = [...new Set(users.map(u => u.tenantId))];
    const tenants = await Tenant.find({ _id: { $in: tenantIds } }).lean();
    const shifts = await Shift.find({ tenantId: { $in: tenantIds }, isActive: true }).lean();

    for (const key of entryKeys) {
      const stats = inspectorData[key];
      const user = users.find(u => u._id.toString() === stats.userId);
      if (!user) continue;

      const tenant = tenants.find(t => t._id.toString() === user.tenantId?.toString());
      const shift = shifts.find(s => s.assignedInspectors.some(id => id.toString() === stats.userId));
      const formInfo = fetchedForms.find(f => f.id === stats.formId || f._id.toString() === stats.formId);

      finalSummary.push({
        tenantName: tenant ? (tenant.companyName || tenant.name) : 'N/A',
        date: stats.date,
        shift: shift ? shift.displayName : 'N/A',
        formTitle: formInfo ? formInfo.title : 'N/A',
        qcInspector: `${user.firstName} ${user.lastName}`,
        role: user.role,
        username: user.username,
        email: user.email,
        isActive: user.isActive,
        status: user.status,
        totalInspection: stats.totalInspection,
        statusCounts: stats.statusCounts,
        userId: stats.userId,
        formId: stats.formId
      });
    }

    // Sort by date descending
    finalSummary.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Static display order for the main columns
    const allStatuses = ['Direct Ok', 'Rework QC Completed', 'Rework QC Pending', 'Rejected', 'Dispatched'];

    res.json({
      success: true,
      data: {
        summary: finalSummary,
        allStatuses
      }
    });
  } catch (error) {
    console.error('getInspectorSummary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

function formatTimeDuration(seconds) {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const getMyReviewStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const userEmail = req.user.email;
    const userUsername = req.user.username;

    // Get total responses by this user
    // We match by createdBy (ObjectId) or submittedBy (email/username)
    const totalResponses = await Response.countDocuments({
      $or: [
        { createdBy: userId },
        { submittedBy: userEmail },
        { submittedBy: userUsername }
      ]
    });

    // Find all reviews for this user to calculate accurate stats
    // submitterId can be stored as ObjectId string or email/name
    const reviews = await Review.find({
      $or: [
        { submitterId: userId.toString() },
        { submitterId: userEmail },
        { submitterId: userUsername }
      ]
    });

    const total = reviews.length;
    const accepted = reviews.filter(r => r.reviewOption === 'Accepted').length;
    const rejected = reviews.filter(r => r.reviewOption === 'Rejected').length;
    const rework = reviews.filter(r => r.reviewOption === 'Rework').length;

    // Calculate score from actual review data: (Accepted / Total) * 100
    const performanceScore = total > 0 ? Math.round((accepted / total) * 100) : 0;

    const stats = {
      totalResponses,
      reviewed: total,
      accepted,
      rejected,
      rework,
      performanceScore
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error in getMyReviewStats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch review statistics'
    });
  }
};

// ─── Simple in-memory cache for the performance table (5 min TTL) ───────────
// Keyed by every input that changes the result. Cleared automatically once
// stale entries are read (lazy eviction) so this never needs a background
// timer. This is process-local, so it resets on redeploy/restart - that's
// fine for a "nice to have" speed boost, not a correctness requirement.
const PERFORMANCE_TABLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const performanceTableCache = new Map();

const buildPerformanceTableCacheKey = ({
  tenantKey, startDate, endDate, formId, queryTenantId, page, limit
}) => JSON.stringify({ tenantKey, startDate, endDate, formId, queryTenantId, page, limit });

const getCachedPerformanceTable = (key) => {
  const entry = performanceTableCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > PERFORMANCE_TABLE_CACHE_TTL_MS) {
    performanceTableCache.delete(key);
    return null;
  }
  return entry.payload;
};

const setCachedPerformanceTable = (key, payload) => {
  performanceTableCache.set(key, { payload, cachedAt: Date.now() });
};

export const getPerformanceTable = async (req, res) => {
  try {
    const { startDate, endDate, formId, tenantId: queryTenantId } = req.query;
    const { role, tenantId: userTenantId, _id: userId } = req.user;

    // ── Pagination params ────────────────────────────────────────────────
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();
    if (endDate) end.setHours(23, 59, 59, 999);

    let tenantFilter = { ...req.tenantFilter };
    let crossTenantAccess = false;
    let targetTenantId = null;

    // Check cross-tenant access
    if (queryTenantId && queryTenantId !== userTenantId?.toString()) {
      let hasAccess = false;

      if (role === 'superadmin') {
        hasAccess = true;
      } else if (userTenantId) {
        const currentUserTenant = await Tenant.findById(userTenantId).maxTimeMS(30000).lean();
        if (currentUserTenant && currentUserTenant.internalTrackingEnabled) {
          const allowedIds = (currentUserTenant.allowedTenantIds || []).map(id => id.toString());
          if (allowedIds.includes(queryTenantId)) {
            hasAccess = true;
            crossTenantAccess = true;
            targetTenantId = queryTenantId;
          }
        }
      }

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access to this tenant is denied for Performance Table.'
        });
      }
    }

    // ── Cache check ─────────────────────────────────────────────────────
    const cacheKey = buildPerformanceTableCacheKey({
      tenantKey: userTenantId?.toString() || 'superadmin',
      startDate: startDate || null,
      endDate: endDate || null,
      formId: formId || null,
      queryTenantId: queryTenantId || null,
      page,
      limit
    });

    const cached = getCachedPerformanceTable(cacheKey);
    if (cached) {
      console.log('[Performance Table] Cache hit', cacheKey);
      return res.json(cached);
    }

    // Determine which users to show
    let usersQuery = { ...tenantFilter };

    if (crossTenantAccess && targetTenantId) {
      usersQuery = {
        $or: [
          { tenantId: userTenantId },
          { tenantId: new mongoose.Types.ObjectId(targetTenantId) }
        ]
      };
    } else if (queryTenantId && role === 'superadmin') {
      usersQuery = { tenantId: new mongoose.Types.ObjectId(queryTenantId) };
    }

    // `users` and the form lookup are independent of each other - the form
    // lookup only feeds the *response* query below, not the users query -
    // so fetch both concurrently instead of one after another.
    let formIdVariants = null;
    let formDoc = null;
    let formTenantId = null;
    let sharedWithTenants = [];
    let chassisTenantAssignments = [];

    const formLookupPromise = formId
      ? Form.findOne({
        $or: [
          { id: formId },
          ...(mongoose.Types.ObjectId.isValid(formId) ? [{ _id: formId }] : []),
        ],
      })
        .select('id _id tenantId sharedWithTenants chassisTenantAssignments sections')
        .maxTimeMS(30000)
        .lean()
      : Promise.resolve(null);

    let [users, formLookupResult] = await Promise.all([
      User.find(usersQuery)
        .populate('tenantId', 'name companyName')
        .select('firstName lastName username email role tenantId isActive status')
        .maxTimeMS(30000)
        .lean(),
      formLookupPromise,
    ]);

    console.log(`[Performance Table] Found ${users.length} users from current tenant(s)`);

    if (formId) {
      formDoc = formLookupResult;
      if (formDoc) {
        formTenantId = formDoc.tenantId?.toString();
        sharedWithTenants = (formDoc.sharedWithTenants || []).map(id => id.toString());
        chassisTenantAssignments = formDoc.chassisTenantAssignments || [];
        formIdVariants = [formDoc.id, formDoc._id?.toString()].filter(Boolean);
      } else {
        formIdVariants = [formId];
      }
    }

    // Build response query
    const responseBaseFilter = {
      createdAt: { $gte: start, $lte: end }
    };

    if (formId) {
      responseBaseFilter.questionId = { $in: formIdVariants };
    }

    if (!formId) {
      Object.assign(responseBaseFilter, tenantFilter);
    }

    // ── Total count (for hasMore) + paginated fetch ────────────────────
    // NOTE: pagination here is applied to the *responses* query itself
    // (skip/limit), not to the aggregated per-user table below - the
    // aggregation is computed only over the current page of responses.
    // This keeps memory bounded and response times fast even with
    // thousands of responses, at the cost of the performance table
    // reflecting only the responses in the current page rather than the
    // full date range in one shot. The frontend pages through with
    // `hasMore` to see the rest.
    const [totalResponsesInRange, allResponses] = await Promise.all([
      Response.countDocuments(responseBaseFilter).maxTimeMS(30000),
      Response.find(responseBaseFilter)
        .select('createdBy submittedBy isDispatched biwReview answers questionId createdAt id _id')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .maxTimeMS(30000)
        .lean(),
    ]);

    console.log(`[Performance Table] Found ${allResponses.length} responses on page ${page} (of ${totalResponsesInRange} total in range)`);

    // Filter responses for chassis-shared tenants
    let filteredResponses = allResponses;

    if (formDoc && crossTenantAccess) {
      const userTenantIdStr = userTenantId?.toString();
      const hasChassisShare = chassisTenantAssignments.some(
        a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr)
      );

      if (hasChassisShare && !sharedWithTenants.includes(userTenantIdStr)) {
        const myAssignedChassis = chassisTenantAssignments
          .filter(a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr))
          .map(a => a.chassisNumber)
          .filter(Boolean);

        if (myAssignedChassis.length > 0) {
          let chassisQuestionId = null;
          if (formDoc?.sections) {
            for (const section of formDoc.sections) {
              if (section.questions) {
                for (const q of section.questions) {
                  if (
                    q.type === 'chassis' ||
                    q.type === 'chassisWithZone' ||
                    q.type === 'chassisWithoutZone' ||
                    q.text?.toLowerCase().includes('chassis')
                  ) {
                    chassisQuestionId = q.id;
                    break;
                  }
                }
              }
              if (chassisQuestionId) break;
            }
          }

          filteredResponses = allResponses.filter(r => {
            const answersObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers;
            const chassisValue = answersObj?.[chassisQuestionId] || answersObj?.chassis_number;
            return chassisValue && myAssignedChassis.includes(String(chassisValue));
          });
        } else {
          filteredResponses = [];
        }
      }
    }

    // Get all unique user IDs from responses
    const userIdsFromResponses = filteredResponses
      .map(r => r.createdBy?.toString())
      .filter(Boolean);

    const objectIdsFromResponses = filteredResponses
      .map(r => r.createdBy)
      .filter(id => id && mongoose.Types.ObjectId.isValid(id))
      .map(id => id.toString());

    const allUserIds = [...new Set([...userIdsFromResponses, ...objectIdsFromResponses])];
    console.log(`[Performance Table] Found ${allUserIds.length} unique user IDs from responses`);

    // Fetch cross-tenant users
    const crossTenantUserIds = allUserIds.filter(id =>
      !users.some(u => u._id.toString() === id)
    );

    if (crossTenantUserIds.length > 0) {
      console.log(`[Performance Table] Fetching ${crossTenantUserIds.length} cross-tenant users`);

      // Only fetch valid ObjectIds
      const validObjectIds = crossTenantUserIds
        .filter(id => /^[0-9a-f]{24}$/i.test(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (validObjectIds.length > 0) {
        const crossTenantUsers = await User.find({
          _id: { $in: validObjectIds }
        })
          .select('firstName lastName username email role tenantId isActive status')
          .populate('tenantId', 'name companyName')
          .maxTimeMS(30000)
          .lean();

        if (crossTenantUsers.length > 0) {
          // Avoid duplicates
          const existingIds = new Set(users.map(u => u._id.toString()));
          const newUsers = crossTenantUsers.filter(u => !existingIds.has(u._id.toString()));
          users = [...users, ...newUsers];
          console.log(`[Performance Table] Added ${newUsers.length} cross-tenant users`);
        }
      }
    }

    // Get response IDs for review fetching
    const responseIds = [];
    filteredResponses.forEach(r => {
      if (r._id) responseIds.push(r._id.toString());
      if (r.id) responseIds.push(r.id);
    });

    const uniqueResponseIds = [...new Set(responseIds)];
    console.log(`[Performance Table] Looking for reviews with ${uniqueResponseIds.length} response IDs`);

    if (uniqueResponseIds.length === 0) {
      const emptyPayload = {
        success: true,
        data: [],
        summary: { totalUsers: 0, totalSubmissions: 0, totalDispatched: 0, totalReviewed: 0, averageScore: 0 },
        meta: {
          formId: formId || null,
          totalResponses: 0,
          totalResponsesInRange
        },
        pagination: {
          page,
          limit,
          hasMore: skip + limit < totalResponsesInRange
        }
      };
      setCachedPerformanceTable(cacheKey, emptyPayload);
      return res.json(emptyPayload);
    }

    // Fetch reviews - handle both ObjectId and non-ObjectId (email/username)
    // submitterId values by splitting the response-id lookup from the
    // submitter-type lookup up front, with maxTimeMS to avoid hanging.
    const reviewQuery = {
      $or: [
        { responseId: { $in: uniqueResponseIds } },
        { response_id: { $in: uniqueResponseIds } },
        { response: { $in: uniqueResponseIds } },
        { responseId: { $in: filteredResponses.map(r => r._id) } }
      ]
    };

    const reviews = await Review.find(reviewQuery).maxTimeMS(30000).lean();
    console.log(`[Performance Table] Found ${reviews.length} reviews`);

    // Get reviewer IDs from reviews
    const reviewerIds = reviews
      .map(r => r.submitterId || r.submittedBy || r.createdBy || r.userId || r.revieweeId)
      .filter(Boolean)
      .map(id => id.toString());

    const uniqueReviewerIds = [...new Set(reviewerIds)];
    console.log(`[Performance Table] Found ${uniqueReviewerIds.length} unique reviewer IDs from reviews`);

    // ============ Fetch cross-tenant reviewers, split by type ============
    const crossTenantReviewerIds = uniqueReviewerIds.filter(id =>
      !users.some(u => u._id.toString() === id)
    );

    if (crossTenantReviewerIds.length > 0) {
      console.log(`[Performance Table] Fetching ${crossTenantReviewerIds.length} cross-tenant reviewers`);

      // Step 1: valid ObjectId strings -> fetch by _id
      const validObjectIds = crossTenantReviewerIds
        .filter(id => /^[0-9a-f]{24}$/i.test(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (validObjectIds.length > 0) {
        try {
          const crossTenantReviewers = await User.find({
            _id: { $in: validObjectIds }
          })
            .select('firstName lastName username email role tenantId isActive status')
            .populate('tenantId', 'name companyName')
            .maxTimeMS(30000)
            .lean();

          if (crossTenantReviewers.length > 0) {
            const existingIds = new Set(users.map(u => u._id.toString()));
            const newReviewers = crossTenantReviewers.filter(u => !existingIds.has(u._id.toString()));
            users = [...users, ...newReviewers];
            console.log(`[Performance Table] Added ${newReviewers.length} cross-tenant reviewers`);
          }
        } catch (err) {
          console.error('Error fetching cross-tenant reviewers:', err);
        }
      }

      // Step 2: non-ObjectId strings (emails / usernames) -> fetch by email or username
      const nonObjectIdReviewers = crossTenantReviewerIds.filter(id => {
        if (typeof id !== 'string') return true;
        return !/^[0-9a-f]{24}$/i.test(id);
      });

      if (nonObjectIdReviewers.length > 0) {
        console.log(`[Performance Table] Searching for ${nonObjectIdReviewers.length} reviewers by email/username`);

        const orConditions = [];
        nonObjectIdReviewers.forEach(id => {
          const idStr = String(id).toLowerCase().trim();
          if (idStr) {
            orConditions.push(
              { email: { $regex: `^${idStr}$`, $options: 'i' } },
              { username: { $regex: `^${idStr}$`, $options: 'i' } }
            );
          }
        });

        if (orConditions.length > 0) {
          try {
            const additionalReviewers = await User.find({
              $or: orConditions
            })
              .select('firstName lastName username email role tenantId isActive status')
              .populate('tenantId', 'name companyName')
              .maxTimeMS(30000)
              .lean();

            if (additionalReviewers.length > 0) {
              const existingIds = new Set(users.map(u => u._id.toString()));
              const newReviewers = additionalReviewers.filter(u => !existingIds.has(u._id.toString()));
              users = [...users, ...newReviewers];
              console.log(`[Performance Table] Added ${newReviewers.length} reviewers by email/username`);
            }
          } catch (err) {
            console.error('Error fetching reviewers by email/username:', err);
          }
        }
      }
    }

    // Build user lookup maps
    const userMap = {};
    const emailToUserId = {};
    const usernameToUserId = {};
    const nameToUserId = {};
    const idToUser = {};

    users.forEach(u => {
      const uId = u._id.toString();
      userMap[uId] = u;
      idToUser[uId] = u;
      if (u.email) emailToUserId[u.email.toLowerCase()] = uId;
      if (u.username) usernameToUserId[u.username.toLowerCase()] = uId;
      const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
      if (fullName.trim()) nameToUserId[fullName] = uId;
    });

    console.log(`[Performance Table] Total users available: ${Object.keys(userMap).length}`);

    // Process reviews and build review map. `submitterIdType` (when present
    // on the review doc) short-circuits the lookup instead of trying every
    // map in sequence.
    const reviewMap = {};

    reviews.forEach(review => {
      const submitterId = review.submitterId || review.submittedBy || review.createdBy || review.userId || review.revieweeId;

      if (!submitterId) return;

      let submitterIdStr = String(submitterId);
      let mappedUserId = null;

      if (userMap[submitterIdStr]) {
        mappedUserId = submitterIdStr;
      } else if (review.submitterIdType === 'email' && emailToUserId[submitterIdStr.toLowerCase()]) {
        mappedUserId = emailToUserId[submitterIdStr.toLowerCase()];
      } else if (review.submitterIdType === 'username' && usernameToUserId[submitterIdStr.toLowerCase()]) {
        mappedUserId = usernameToUserId[submitterIdStr.toLowerCase()];
      } else if (emailToUserId[submitterIdStr.toLowerCase()]) {
        mappedUserId = emailToUserId[submitterIdStr.toLowerCase()];
      } else if (usernameToUserId[submitterIdStr.toLowerCase()]) {
        mappedUserId = usernameToUserId[submitterIdStr.toLowerCase()];
      } else if (nameToUserId[submitterIdStr.toLowerCase()]) {
        mappedUserId = nameToUserId[submitterIdStr.toLowerCase()];
      } else if (mongoose.Types.ObjectId.isValid(submitterIdStr)) {
        try {
          const objId = new mongoose.Types.ObjectId(submitterIdStr);
          if (userMap[objId.toString()]) {
            mappedUserId = objId.toString();
          }
        } catch (err) {
          // Not a valid ObjectId
        }
      }

      const finalUserId = mappedUserId || submitterIdStr;

      if (!reviewMap[finalUserId]) {
        reviewMap[finalUserId] = { total: 0, accepted: 0, rejected: 0, rework: 0 };
      }

      const reviewOption = review.reviewOption || review.status || review.option || review.reviewStatus;

      reviewMap[finalUserId].total++;

      if (reviewOption === 'Accepted' || reviewOption === 'accept' || reviewOption === 'approved') {
        reviewMap[finalUserId].accepted++;
      } else if (reviewOption === 'Rejected' || reviewOption === 'reject' || reviewOption === 'rejected') {
        reviewMap[finalUserId].rejected++;
      } else if (reviewOption === 'Rework' || reviewOption === 'rework' || reviewOption === 'reworked') {
        reviewMap[finalUserId].rework++;
      }
    });

    console.log(`[Performance Table] Review map has ${Object.keys(reviewMap).length} entries`);

    // Helper: Determine inspection status
    const getInspectionStatus = (response) => {
      let isRework = false;
      let isAccepted = false;
      let isRejected = false;
      let foundStatus = null;

      const answersObj = response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers;

      if (answersObj) {
        Object.values(answersObj).forEach(ans => {
          if (ans === null || ans === undefined) return;

          let s = '';
          if (typeof ans === 'object' && ans.status) {
            s = String(ans.status).trim();
          } else if (typeof ans === 'string') {
            s = ans.trim();
          }

          if (!s) return;
          const sl = s.toLowerCase();

          if (sl === 'rework' || sl === 'reworked' || sl.includes('re-rework')) {
            isRework = true;
          } else if (
            sl === 'accepted' ||
            sl === 'rework completed' ||
            sl === 'verified' ||
            sl === 'yes' ||
            sl === 'direct ok' ||
            sl === 'rework accepted'
          ) {
            isAccepted = true;
          } else if (sl === 'rejected' || sl === 'no') {
            isRejected = true;
          } else {
            foundStatus = s;
          }
        });
      }

      if (isRejected) return 'Rejected';
      if (isRework) return 'Rework QC Pending';
      if (isAccepted) return 'Direct Ok';
      if (foundStatus) return foundStatus;
      return 'Pending';
    };

    // Initialize stats for all users
    const userStatsMap = new Map();

    Object.values(userMap).forEach(user => {
      const uId = user._id.toString();
      userStatsMap.set(uId, {
        userId: uId,
        userName: `${user.firstName} ${user.lastName}`,
        userEmail: user.email,
        userRole: user.role,
        tenantId: user.tenantId?.toString(),
        tenantName: user.tenantId?.name || user.tenantId?.companyName || 'Unknown Tenant',
        totalSubmitted: 0,
        directOk: 0,
        reworkQcCompleted: 0,
        reworkQcPending: 0,
        rejected: 0,
        dispatchPending: 0,
        dispatched: 0,
        totalReviewed: 0,
        reviewPending: 0,
        accepted: 0,
        rejectedReview: 0,
        reworked: 0,
        performanceScore: 0,
        responses: []
      });
    });

    // Add reviewers who aren't in the user map
    Object.keys(reviewMap).forEach(reviewerId => {
      if (!userStatsMap.has(reviewerId)) {
        if (/^[0-9a-f]{24}$/i.test(reviewerId)) {
          userStatsMap.set(reviewerId, {
            userId: reviewerId,
            userName: `User ${reviewerId.substring(0, 8)}`,
            userEmail: '',
            userRole: 'unknown',
            tenantId: null,
            tenantName: 'Cross-Tenant User',
            totalSubmitted: 0,
            directOk: 0,
            reworkQcCompleted: 0,
            reworkQcPending: 0,
            rejected: 0,
            dispatchPending: 0,
            dispatched: 0,
            totalReviewed: 0,
            reviewPending: 0,
            accepted: 0,
            rejectedReview: 0,
            reworked: 0,
            performanceScore: 0,
            responses: []
          });
        }
      }
    });

    // Process responses (same logic as before, just over the current page)
    filteredResponses.forEach(response => {
      let userId = response.createdBy?.toString();

      if (!userId) {
        const userBySubmitted = users.find(u =>
          u.email === response.submittedBy ||
          u.username === response.submittedBy ||
          `${u.firstName} ${u.lastName}` === response.submittedBy
        );
        if (userBySubmitted) {
          userId = userBySubmitted._id.toString();
        } else {
          userId = response.submittedBy || 'unknown';
        }
      }

      if (!userStatsMap.has(userId)) {
        userStatsMap.set(userId, {
          userId,
          userName: response.submittedBy || 'Unknown User',
          userEmail: '',
          userRole: 'inspector',
          tenantId: null,
          tenantName: 'Cross-Tenant User',
          totalSubmitted: 0,
          directOk: 0,
          reworkQcCompleted: 0,
          reworkQcPending: 0,
          rejected: 0,
          dispatchPending: 0,
          dispatched: 0,
          totalReviewed: 0,
          reviewPending: 0,
          accepted: 0,
          rejectedReview: 0,
          reworked: 0,
          performanceScore: 0,
          responses: []
        });
      }

      const stats = userStatsMap.get(userId);
      stats.totalSubmitted++;
      stats.responses.push(response);

      const status = getInspectionStatus(response);
      if (status === 'Direct Ok') stats.directOk++;
      else if (status === 'Rework QC Pending') stats.reworkQcPending++;
      else if (status === 'Rejected') stats.rejected++;

      if (response.isDispatched) {
        stats.dispatched++;
      } else {
        const dispatchableStatuses = ['Direct Ok', 'Rework QC Completed', 'Accepted'];
        if (dispatchableStatuses.includes(status)) {
          stats.dispatchPending++;
        }
      }

      const biwStatus = response.biwReview?.status;
      if (biwStatus === 'Accepted') {
        stats.accepted++;
        stats.totalReviewed++;
      } else if (biwStatus === 'Rejected') {
        stats.rejectedReview++;
        stats.totalReviewed++;
      } else if (biwStatus === 'Reworked') {
        stats.reworked++;
        stats.totalReviewed++;
      }
    });

    // Apply review stats
    console.log('[Performance Table] Applying review stats to users...');

    Object.entries(reviewMap).forEach(([reviewerId, reviewData]) => {
      if (userStatsMap.has(reviewerId)) {
        const stats = userStatsMap.get(reviewerId);
        stats.accepted += reviewData.accepted;
        stats.rejectedReview += reviewData.rejected;
        stats.reworked += reviewData.rework;
        stats.totalReviewed += reviewData.total;
      }
    });

    // Calculate final metrics
    for (const [userId, stats] of userStatsMap) {
      stats.reviewPending = Math.max(0, stats.dispatched - stats.totalReviewed);
      stats.performanceScore = stats.totalReviewed > 0
        ? Math.round((stats.accepted / stats.totalReviewed) * 100)
        : 0;

      if (stats.responses.length > 0) {
        const chassisGroups = new Map();
        stats.responses.forEach(response => {
          const answersObj = response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers;
          let chassisKey = 'unknown';

          for (const [key, value] of Object.entries(answersObj || {})) {
            if (key.includes('chassis') || key.includes('Chassis')) {
              chassisKey = String(value);
              break;
            }
          }

          if (!chassisGroups.has(chassisKey)) {
            chassisGroups.set(chassisKey, []);
          }
          chassisGroups.get(chassisKey).push(response);
        });

        let reworkCompletedCount = 0;
        for (const [chassisKey, chassisResponses] of chassisGroups) {
          const sorted = chassisResponses.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

          sorted.forEach((response, index) => {
            const status = getInspectionStatus(response);
            if (status === 'Direct Ok' && index > 0) {
              reworkCompletedCount++;
            }
          });
        }
        stats.reworkQcCompleted = reworkCompletedCount;
      }
    }

    // Format final table data
    const tableData = Array.from(userStatsMap.values())
      .filter(stats => stats.totalSubmitted > 0 || stats.totalReviewed > 0)
      .map(stats => {
        const user = userMap[stats.userId];

        let displayName = stats.userName;
        let displayEmail = stats.userEmail;
        let displayRole = stats.userRole;
        let tenantName = stats.tenantName || 'Cross-Tenant User';

        if (user) {
          displayName = `${user.firstName} ${user.lastName}`;
          displayEmail = user.email || '';
          displayRole = user.role || 'inspector';
          tenantName = user.tenantId?.name || user.tenantId?.companyName || 'Cross-Tenant User';
        } else if (/^[0-9a-f]{24}$/i.test(stats.userId)) {
          displayName = `User ${stats.userId.substring(0, 8)}`;
        }

        return {
          name: displayName,
          username: user?.username || '',
          email: displayEmail,
          role: displayRole,
          tenantName: tenantName,
          isCrossTenant: !user || (user && user.tenantId?.toString() !== formTenantId),

          directOk: stats.directOk || 0,
          reworkQcCompleted: stats.reworkQcCompleted || 0,
          reworkQcPending: stats.reworkQcPending || 0,
          rejected: stats.rejected || 0,
          dispatchPending: stats.dispatchPending || 0,
          dispatched: stats.dispatched || 0,
          totalSubmitted: stats.totalSubmitted || 0,
          totalReviewed: stats.totalReviewed || 0,
          reviewPending: stats.reviewPending || 0,
          accepted: stats.accepted || 0,
          rejectedReview: stats.rejectedReview || 0,
          reworked: stats.reworked || 0,
          performanceScore: stats.performanceScore || 0
        };
      });

    tableData.sort((a, b) => b.performanceScore - a.performanceScore);

    const summary = {
      totalUsers: tableData.length,
      totalSubmissions: tableData.reduce((sum, row) => sum + row.totalSubmitted, 0),
      totalDispatched: tableData.reduce((sum, row) => sum + row.dispatched, 0),
      totalReviewed: tableData.reduce((sum, row) => sum + row.totalReviewed, 0),
      averageScore: tableData.length > 0
        ? Math.round(tableData.reduce((sum, row) => sum + row.performanceScore, 0) / tableData.length)
        : 0,
      crossTenantUsers: tableData.filter(row => row.isCrossTenant).length
    };

    console.log('[Performance Table] Final summary:', summary);

    const hasMore = skip + allResponses.length < totalResponsesInRange;

    const payload = {
      success: true,
      data: tableData,
      summary,
      meta: {
        formId: formId || null,
        formTenantId: formTenantId || null,
        totalResponses: filteredResponses.length,
        totalResponsesInRange,
        totalReviewsFound: reviews.length,
        totalUsersFetched: users.length
      },
      pagination: {
        page,
        limit,
        hasMore
      }
    };

    setCachedPerformanceTable(cacheKey, payload);

    res.json(payload);

  } catch (error) {
    console.error('Error in getPerformanceTable:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
// OVERALL ANALYTICS

export const getOverallAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, formIds } = req.query;

    // Base match with tenant filtering
    const matchFilter = { ...req.tenantFilter };

    // Apply optional formIds filter
    if (formIds) {
      const ids = formIds.split(',');
      if (!ids.includes('NONE_SELECTED') && ids.length > 0) {
        matchFilter.questionId = { $in: ids };
      }
    }

    // Apply optional date filter
    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        const s = new Date(startDate);
        s.setHours(0, 0, 0, 0);
        matchFilter.createdAt.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        matchFilter.createdAt.$lte = e;
      }
    }

    // Fetch responses for this query
    const responses = await Response.find(matchFilter).sort({ createdAt: -1 }).lean();

    if (!responses || responses.length === 0) {
      return res.json({
        success: true,
        data: {
          responses: [],
          uniqueForms: [],
          summaryTotals: { total: 0, yesCount: 0, noCount: 0, naCount: 0 },
          sectionStats: [],
          totalResponses: 0,
          totalYes: 0,
          totalQuestions: 0,
          overallScore: "0.0",
          dailyTrend: [],
          stats: { yes: 0, no: 0, na: 0, accepted: 0, rejected: 0, rework: 0 }
        }
      });
    }

    // Extract formIds to get form details
    const uniqueFormIds = [...new Set(responses.map(r => r.questionId).filter(Boolean))];
    const forms = await Form.find({
      $or: [
        { id: { $in: uniqueFormIds } },
        { _id: { $in: uniqueFormIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
      ]
    }).lean();

    const formMap = {};
    const dealerQuestionMap = new Map();

    forms.forEach(form => {
      const fid = form.id || form._id.toString();
      formMap[fid] = form;

      // Identify dealer questions
      if (form.sections?.length > 0) {
        const first = form.sections[0];
        if (first.questions?.length > 0) {
          for (const q of first.questions) {
            const txt = (q.text || q.label || "").toLowerCase();
            if (
              txt.includes("dealer") ||
              txt.includes("distributor") ||
              txt.includes("store") ||
              txt.includes("business")
            ) {
              dealerQuestionMap.set(fid, q.id);
              break;
            }
          }
        }
      }
    });

    // Helper functions replicated from frontend logic
    const extractYesNoValues = (value) => {
      if (value === null || value === undefined) return [];
      if (typeof value === "string") {
        const n = value.trim().toLowerCase();
        return n ? [n] : [];
      }
      if (typeof value === "boolean") return [value ? "yes" : "no"];
      if (Array.isArray(value)) return value.flatMap(extractYesNoValues);
      if (typeof value === "object") return Object.values(value).flatMap(extractYesNoValues);
      return [];
    };

    const computeResponseStats = (answers) => {
      let yes = 0, no = 0, na = 0, accepted = 0, rejected = 0, rework = 0;
      const values = extractYesNoValues(answers);
      values.forEach((val) => {
        if (val === "yes") yes++;
        else if (val === "no") no++;
        else if (val === "na" || val === "n/a" || val === "n.a" || val === "n.a.") na++;
        else if (val === "accepted" || val === "accept") accepted++;
        else if (val === "rejected" || val === "reject") rejected++;
        else if (val === "rework") rework++;
      });
      return { yes, no, na, accepted, rejected, rework };
    };

    const collectYesNoQuestionIds = (form) => {
      const ids = new Set();
      const processQuestion = (q) => {
        if (!q) return;
        if (q.type === "yesNoNA" && q.id) ids.add(q.id);
        q.followUpQuestions?.forEach(processQuestion);
      };
      form.sections?.forEach((s) => s.questions?.forEach(processQuestion));
      return Array.from(ids);
    };

    const computeYesNoScore = (answers, form) => {
      const ids = collectYesNoQuestionIds(form);
      if (!ids.length) return { yes: 0, total: 0 };
      let yes = 0;
      ids.forEach((id) => {
        if (extractYesNoValues(answers?.[id]).includes("yes")) yes++;
      });
      return { yes, total: ids.length };
    };

    const renderAnswerDisplay = (value) => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value.trim();
      if (Array.isArray(value)) return value.map(renderAnswerDisplay).filter(Boolean).join(", ");
      if (typeof value === "object") {
        const s = value.value || value.text || value.label || "";
        return s ? String(s) : "";
      }
      return String(value);
    };

    const extractDealer = (response, form) => {
      if (!form || !response.answers) return { name: null, rank: null };
      const fid = form._id?.toString() || form.id;
      if (!fid) return { name: null, rank: null };
      const dqid = dealerQuestionMap.get(fid);
      const answersObj = response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers;

      const hasAnswerValue = (v) => {
        if (v === null || v === undefined) return false;
        if (typeof v === 'string') return v.trim() !== '';
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        return true;
      };

      if (dqid) {
        const ans = answersObj[dqid];
        if (ans && hasAnswerValue(ans)) {
          return { name: renderAnswerDisplay(ans), rank: response.responseRanks?.[dqid] || null };
        }
      }
      if (form.sections?.length > 0) {
        const first = form.sections[0];
        if (first.questions?.length > 0) {
          for (const q of first.questions) {
            const ans = answersObj[q.id];
            if (ans && hasAnswerValue(ans)) {
              return { name: renderAnswerDisplay(ans), rank: response.responseRanks?.[q.id] || null };
            }
          }
        }
      }
      return { name: null, rank: null };
    };

    // Enrich responses
    const enrichedResponses = responses.map(r => {
      const fid = r.questionId;
      const form = formMap[fid];
      const dealer = extractDealer(r, form);
      const answersObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers;

      let firstQ = "Unknown Question";
      let firstA = "N/A";
      if (form && form.sections?.length > 0) {
        for (const section of form.sections) {
          if (section.questions?.length > 0) {
            const q = section.questions[0];
            firstQ = q.text || q.label || q.id || "Unknown Question";
            firstA = renderAnswerDisplay(answersObj?.[q.id]) || "N/A";
            break;
          }
        }
      } else if (answersObj && Object.keys(answersObj).length > 0) {
        const firstKey = Object.keys(answersObj)[0];
        firstQ = firstKey;
        firstA = renderAnswerDisplay(answersObj[firstKey]) || "N/A";
      }

      return {
        _id: r._id,
        id: r.id,
        questionId: r.questionId,
        formId: r.formId,
        parentResponseId: r.parentResponseId,
        answers: answersObj,
        responseRanks: r.responseRanks,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        status: r.status,
        submissionMetadata: r.submissionMetadata,
        formTitle: form?.title || "Unknown Form",
        yesNoScore: form ? computeYesNoScore(answersObj, form) : undefined,
        stats: computeResponseStats(answersObj),
        dealerName: dealer.name || "Unknown",
        dealerRank: dealer.rank,
        firstQuestionText: firstQ,
        firstAnswerValue: firstA,
      };
    });

    const totalYes = enrichedResponses.reduce((s, r) => s + (r.yesNoScore?.yes || 0), 0);
    const totalQuestions = enrichedResponses.reduce((s, r) => s + (r.yesNoScore?.total || 0), 0);
    const overallScore = totalQuestions > 0 ? ((totalYes / totalQuestions) * 100).toFixed(1) : "0.0";

    const sectionStatsMap = new Map();
    enrichedResponses.forEach((r) => {
      if (!r.stats) return;
      const key = r.questionId || r.formId || "";
      const title = r.formTitle;
      if (!key) return;
      if (!sectionStatsMap.has(key)) {
        sectionStatsMap.set(key, {
          id: key, title, yes: 0, no: 0, na: 0, accepted: 0, rejected: 0, rework: 0, total: 0
        });
      }
      const s = sectionStatsMap.get(key);
      s.yes += r.stats.yes;
      s.no += r.stats.no;
      s.na += r.stats.na;
      s.accepted += r.stats.accepted;
      s.rejected += r.stats.rejected;
      s.rework += r.stats.rework;
      s.total += r.stats.yes + r.stats.no + r.stats.na + r.stats.accepted + r.stats.rejected + r.stats.rework;
    });

    const sectionStats = Array.from(sectionStatsMap.values());

    let globalStats = { yes: 0, no: 0, na: 0, accepted: 0, rejected: 0, rework: 0 };
    enrichedResponses.forEach(r => {
      if (r.stats) {
        globalStats.yes += r.stats.yes;
        globalStats.no += r.stats.no;
        globalStats.na += r.stats.na;
        globalStats.accepted += r.stats.accepted;
        globalStats.rejected += r.stats.rejected;
        globalStats.rework += r.stats.rework;
      }
    });

    const summaryTotals = sectionStats.reduce(
      (acc, s) => ({
        total: acc.total + s.total,
        yesCount: acc.yesCount + s.yes + s.accepted,
        noCount: acc.noCount + s.no + s.rejected,
        naCount: acc.naCount + s.na + s.rework,
      }),
      { total: 0, yesCount: 0, noCount: 0, naCount: 0 }
    );

    const dailyTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const dateStr = d.toDateString();
      const count = enrichedResponses.filter(r => new Date(r.createdAt).toDateString() === dateStr).length;
      dailyTrend.push({ date: label, count });
    }

    const uniqueForms = forms.map(f => ({ id: f.id || f._id.toString(), title: f.title }));

    res.json({
      success: true,
      data: {
        responses: enrichedResponses, // Return all data for Customer Requests grouping
        uniqueForms,
        summaryTotals,
        sectionStats,
        totalResponses: enrichedResponses.length,
        totalYes,
        totalQuestions,
        overallScore,
        dailyTrend,
        stats: globalStats
      }
    });

  } catch (error) {
    console.error('getOverallAnalytics error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Quality and Inspector Performance Summary (Mirrors Excel Pivot & Daily Sheet)
 */
export const getQualitySummary = async (req, res) => {
  try {
    const startTimer = Date.now();
    const { formId, startDate, endDate, tenantId: queryTenantId } = req.query;
    const { role, tenantId: userTenantId } = req.user;

    // ─── Cache check (3 minute TTL) ─────────────────────────────────────
    const cacheKey = `quality_summary_v7_${userTenantId || 'superadmin'}_${formId || 'all'}_${startDate || ''}_${endDate || ''}_${queryTenantId || ''}`;
    const cached = appCache.get(cacheKey);
    if (cached) {
      console.log(`[Quality Summary] Cache HIT (${cacheKey}) - returning in ${Date.now() - startTimer}ms`);
      return res.json(cached);
    }
    console.log(`[Quality Summary] Cache MISS (${cacheKey}) - computing from DB...`);

    // 1. Identify target tenant
    let targetTenantId = userTenantId;
    if (role === 'superadmin' && queryTenantId) {
      targetTenantId = queryTenantId;
    }

    // 2. Fetch accessible forms
    const formQuery = {};
    if (role === 'superadmin' && !queryTenantId) {
      // Superadmin sees all forms
    } else if (targetTenantId) {
      const tIdObj = mongoose.Types.ObjectId.isValid(targetTenantId)
        ? new mongoose.Types.ObjectId(targetTenantId)
        : targetTenantId;

      formQuery.$or = [
        { tenantId: tIdObj },
        { tenantId: targetTenantId.toString() },
        { isGlobal: true },
        { sharedWithTenants: targetTenantId.toString() },
        { sharedWithTenants: tIdObj },
        { 'chassisTenantAssignments.assignedTenants': targetTenantId.toString() }
      ];
    }

    const accessibleForms = await Form.find(formQuery)
      .select('id _id title sections tenantId')
      .lean();

    const formTitleMap = {};
    const formChassisQuestionMap = {};
    const questionTitleMap = {};
    const questionMetaMap = {};

    accessibleForms.forEach(f => {
      const idStr = f.id ? f.id.toString() : '';
      const mongoIdStr = f._id ? f._id.toString() : '';
      if (idStr) formTitleMap[idStr] = f.title;
      if (mongoIdStr) formTitleMap[mongoIdStr] = f.title;

      const fIds = [idStr, mongoIdStr].filter(Boolean);
      let primaryChassisQId = null;

      (f.sections || []).forEach(sec => {
        (sec.questions || []).forEach(q => {
          if (!q.id) return;
          const qText = (q.text || '').trim();
          const qTextLow = qText.toLowerCase();
          const qType = q.type || '';

          questionTitleMap[q.id] = qText;
          questionMetaMap[q.id] = { text: qText, type: qType, formId: idStr || mongoIdStr };

          if (!primaryChassisQId) {
            if (
              qType === 'chassis' ||
              qType === 'chassisWithZone' ||
              qType === 'chassisWithoutZone' ||
              qTextLow === 'chassis number' ||
              qTextLow === 'identification number' ||
              qTextLow === 'id number' ||
              qTextLow === 'chassis' ||
              qTextLow === 'chassis / vin' ||
              qTextLow.includes('chassis number') ||
              qTextLow.includes('identification number') ||
              qTextLow.includes('id number') ||
              qTextLow.includes('registration number')
            ) {
              primaryChassisQId = q.id;
            }
          }
        });
      });

      fIds.forEach(fid => {
        formChassisQuestionMap[fid] = { primaryChassisQId };
      });
    });

    // 3. Build response filter
    let formKeys = [];
    if (formId && formId !== 'all') {
      const selectedForm = accessibleForms.find(
        f => f.id === formId || f._id.toString() === formId
      );
      if (selectedForm) {
        formKeys = [selectedForm.id, selectedForm._id?.toString()].filter(Boolean);
      } else {
        formKeys = [formId];
      }
    } else {
      formKeys = accessibleForms.flatMap(f => [f.id, f._id?.toString()]).filter(Boolean);
    }

    const responseFilter = {
      questionId: { $in: formKeys },
      isSectionSubmit: { $ne: true }
    };

    if (startDate || endDate) {
      responseFilter.createdAt = {};
      if (startDate) responseFilter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        responseFilter.createdAt.$lte = end;
      }
    }

    // 4. Ultra-fast MongoDB Aggregation Pipeline (computed directly in DB engine)
    const pipeline = [
      { $match: responseFilter },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                rework1Count: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework 1' } },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          byForm: [
            {
              $group: {
                _id: '$questionId',
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                rework1Count: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework 1' } },
                      1,
                      0
                    ]
                  }
                },
                biwAcceptCount: {
                  $sum: {
                    $cond: [
                      { $eq: ['$biwReview.status', 'Accepted'] },
                      1,
                      0
                    ]
                  }
                },
                biwDefectCount: {
                  $sum: {
                    $cond: [
                      { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                      1,
                      0
                    ]
                  }
                },
                inspectors: { $addToSet: '$submittedBy' },
                lastInspectionDate: { $max: '$createdAt' }
              }
            }
          ],
          byInspector: [
            {
              $group: {
                _id: { $ifNull: ['$submittedBy', 'Unknown Submitter'] },
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                rework1Count: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework 1' } },
                      1,
                      0
                    ]
                  }
                },
                biwAcceptCount: {
                  $sum: {
                    $cond: [
                      { $eq: ['$biwReview.status', 'Accepted'] },
                      1,
                      0
                    ]
                  }
                },
                biwDefectCount: {
                  $sum: {
                    $cond: [
                      { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          byDay: [
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                },
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                reworkCount: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework 1' } },
                      1,
                      0
                    ]
                  }
                }
              }
            },
            { $sort: { _id: 1 } }
          ],
          recentResponses: [
            { $sort: { createdAt: -1 } },
            { $limit: 200 },
            {
              $project: {
                submittedBy: 1,
                status: 1,
                biwReview: 1,
                createdAt: 1,
                questionId: 1,
                formId: 1,
                isDispatched: 1,
                chassisNumber: 1
              }
            }
          ],
          defectResponses: [
            {
              $match: {
                $or: [
                  { 'biwReview.status': { $in: ['Rejected', 'Reworked'] } },
                  { status: { $regex: 'rework|rejected|defect|fail', $options: 'i' } }
                ]
              }
            },
            { $limit: 100 },
            { $project: { _id: 1, submittedBy: 1, answers: 1 } }
          ]
        }
      }
    ];

    const aggResult = await Response.aggregate(pipeline).option({ maxTimeMS: 60000 });
    const agg = aggResult[0] || {};

    const summary = agg.summary?.[0] || { totalChecked: 0, defectCount: 0, rework1Count: 0 };
    const totalChecked = summary.totalChecked || 0;
    const totalDefects = summary.defectCount || 0;
    const totalAccepted = Math.max(0, totalChecked - totalDefects);
    const totalRework1 = summary.rework1Count || 0;
    const overallAcceptRate = totalChecked > 0 ? Math.round((totalAccepted / totalChecked) * 10000) / 100 : 0;
    const overallDefectRate = Math.max(0, Math.round((100 - overallAcceptRate) * 100) / 100);

    // Defect breakdown extraction from top defect responses
    const defectTypeMap = {};
    const inspectorDefectMap = {};

    (agg.defectResponses || []).forEach(dr => {
      const rawName = (dr.submittedBy || 'Unknown Submitter').trim();
      if (!inspectorDefectMap[rawName]) inspectorDefectMap[rawName] = {};

      if (dr.answers && typeof dr.answers === 'object') {
        const answersObj = dr.answers instanceof Map ? Object.fromEntries(dr.answers) : dr.answers;
        for (const [key, val] of Object.entries(answersObj)) {
          if (!val) continue;
          let isDef = false;
          if (typeof val === 'object' && val.status) {
            const st = String(val.status).trim().toLowerCase();
            if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok'].includes(st)) isDef = true;
          } else if (typeof val === 'string') {
            const vLow = val.trim().toLowerCase();
            if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok'].includes(vLow)) isDef = true;
          }

          if (isDef) {
            const qTitle = questionTitleMap[key] || key;
            defectTypeMap[qTitle] = (defectTypeMap[qTitle] || 0) + 1;
            inspectorDefectMap[rawName][qTitle] = (inspectorDefectMap[rawName][qTitle] || 0) + 1;
          }
        }
      }
    });

    const defectBreakdown = Object.entries(defectTypeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    // Per-Form Summary List
    const formMetricMap = {};
    (agg.byForm || []).forEach(item => {
      formMetricMap[item._id] = item;
    });

    const formsSummary = accessibleForms.map(f => {
      const m = formMetricMap[f.id] || formMetricMap[f._id.toString()] || {};
      const tChecked = m.totalChecked || 0;
      const dCount = m.defectCount || 0;
      const aCount = Math.max(0, tChecked - dCount);
      const aRate = tChecked > 0 ? Math.round((aCount / tChecked) * 10000) / 100 : 0;
      const dRate = Math.max(0, Math.round((100 - aRate) * 100) / 100);

      return {
        id: f.id || f._id.toString(),
        _id: f._id.toString(),
        title: f.title,
        totalChecked: tChecked,
        acceptCount: aCount,
        defectCount: dCount,
        rework1Count: m.rework1Count || 0,
        biwAcceptCount: m.biwAcceptCount || 0,
        biwDefectCount: m.biwDefectCount || 0,
        acceptRate: aRate,
        defectRate: dRate,
        totalInspectors: m.inspectors ? m.inspectors.length : 0,
        lastInspectionDate: m.lastInspectionDate ? new Date(m.lastInspectionDate).toISOString().split('T')[0] : null
      };
    }).sort((a, b) => b.totalChecked - a.totalChecked);

    const formOptions = formsSummary.map(f => ({
      id: f.id,
      _id: f._id,
      title: f.title,
      totalChecked: f.totalChecked
    }));

    // Inspector performance ratings
    let exemplaryCount = 0;
    let exceededCount = 0;
    let metCount = 0;
    let partiallyMetCount = 0;

    const inspectorList = (agg.byInspector || []).map(insp => {
      const tChecked = insp.totalChecked;
      const dCount = insp.defectCount;
      const aCount = Math.max(0, tChecked - dCount);
      const acceptRate = tChecked > 0 ? Math.round((aCount / tChecked) * 100) : 0;
      const defectRate = Math.max(0, 100 - acceptRate);

      let performanceStatus = 'Partially met performer';
      let tier = 'partially-met';
      let arrow = 'down';

      if (acceptRate >= 90) {
        performanceStatus = 'Exemplary performer';
        tier = 'exemplary';
        arrow = 'up';
        exemplaryCount++;
      } else if (acceptRate >= 80) {
        performanceStatus = 'Exceeded Performance';
        tier = 'exceeded';
        arrow = 'up-right';
        exceededCount++;
      } else if (acceptRate >= 70) {
        performanceStatus = 'Met expectation';
        tier = 'met';
        arrow = 'right';
        metCount++;
      } else {
        partiallyMetCount++;
      }

      const biwTotal = insp.biwAcceptCount + insp.biwDefectCount;
      const biwAcceptRate = biwTotal > 0 ? Math.round((insp.biwAcceptCount / biwTotal) * 100) : 0;
      const biwDefectRate = Math.max(0, 100 - biwAcceptRate);

      const topDefects = Object.entries(inspectorDefectMap[insp._id] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));

      return {
        name: insp._id,
        totalChecked: tChecked,
        acceptCount: aCount,
        defectCount: dCount,
        rework1Count: insp.rework1Count,
        biwAcceptCount: insp.biwAcceptCount,
        biwDefectCount: insp.biwDefectCount,
        acceptRate,
        defectRate,
        performanceStatus,
        tier,
        arrow,
        biwAcceptRate,
        biwDefectRate,
        topDefects
      };
    }).sort((a, b) => b.totalChecked - a.totalChecked);

    // Daily trends array
    const dailyTrends = (agg.byDay || []).map(d => {
      const aCount = Math.max(0, d.totalChecked - d.defectCount);
      return {
        date: d._id,
        totalChecked: d.totalChecked,
        acceptCount: aCount,
        defectCount: d.defectCount,
        reworkCount: d.reworkCount,
        passRate: d.totalChecked > 0 ? Math.round((aCount / d.totalChecked) * 10000) / 100 : 0
      };
    });

    // Recent raw responses for the Excel-like grid
    const rawResponsesList = (agg.recentResponses || []).map(r => {
      const fTitle = formTitleMap[r.questionId] || formTitleMap[r.formId] || 'Unknown Form';
      const rawSt = (r.status || '').trim();
      let dynamicStatus = rawSt === 'Accepted' || rawSt === 'Direct Ok' || rawSt === 'Rework Accepted' ? rawSt : (rawSt.startsWith('Rework') || rawSt === 'Rejected' ? rawSt : 'Direct Ok');

      return {
        id: r._id.toString(),
        chassisNumber: r.chassisNumber && r.chassisNumber !== 'none' ? r.chassisNumber : 'N/A',
        chassisVin: '-',
        partDescription: '-',
        submittedBy: (r.submittedBy || 'Unknown Submitter').trim(),
        date: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        status: dynamicStatus,
        biwReviewStatus: r.biwReview?.status || (dynamicStatus === 'Direct Ok' || dynamicStatus === 'Accepted' ? 'Accepted' : 'Pending'),
        formId: (r.formId || r.questionId)?.toString() || '',
        formTitle: fTitle,
        isDispatched: Boolean(r.isDispatched),
        defects: []
      };
    });

    const payload = {
      success: true,
      data: {
        summary: {
          totalChecked,
          totalAccepted,
          totalDefects,
          totalRework1,
          overallAcceptRate,
          overallDefectRate,
          totalInspectors: inspectorList.length,
          exemplaryCount,
          exceededCount,
          metCount,
          partiallyMetCount
        },
        formsSummary,
        formOptions,
        inspectors: inspectorList,
        defectBreakdown,
        dailyTrends,
        rawResponses: rawResponsesList // Include raw forms data for the Excel-like grid
      }
    };

    // Cache for 5 minutes (300s)
    appCache.set(cacheKey, payload, 300);
    console.log(`[Quality Summary] Computed in ${Date.now() - startTimer}ms for ${totalChecked} responses, cached as ${cacheKey}`);
    res.json(payload);

  } catch (error) {
    console.error('getQualitySummary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error calculating quality summary' });
  }
};