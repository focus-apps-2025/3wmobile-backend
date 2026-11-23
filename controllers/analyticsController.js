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
                date: {
                  $convert: {
                    input: '$createdAt',
                    to: 'date',
                    onError: new Date(0),
                    onNull: new Date(0)
                  }
                }
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
              date: {
                $convert: {
                  input: '$lastLogin',
                  to: 'date',
                  onError: new Date(0),
                  onNull: new Date(0)
                }
              }
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

    const shouldBypassCache = req.query.forceNetwork === 'true' || req.query.bypassCache === 'true';
    const cacheKey = 'insp_summary_' + (userTenantId || 'superadmin') + '_' + (formId || 'all') + '_' + (startDate || '') + '_' + (endDate || '') + '_' + (queryTenantId || '');
    if (!shouldBypassCache) {
      const cached = appCache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    let matchFilter = {};

    // Helper to get array of [string, ObjectId] for any tenantId
    const getTenantValues = (tId) => {
      if (!tId) return [];
      const tIdStr = tId.toString();
      const tIdObj = mongoose.Types.ObjectId.isValid(tIdStr) ? new mongoose.Types.ObjectId(tIdStr) : null;
      return [tIdStr, tIdObj].filter(Boolean);
    };

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
        const vals = getTenantValues(queryTenantId);
        matchFilter = { tenantId: vals.length === 1 ? vals[0] : { $in: vals } };
      } else {
        return res.status(403).json({ success: false, message: 'Access to this tenant is denied for Inspector Summary.' });
      }
    } else {
      // Default behavior if no tenantId is specified in query
      if (role === 'superadmin') {
        // No initial filter for superadmin, can see all
      } else if (role === 'admin' || role === 'subadmin') {
        const vals = getTenantValues(userTenantId);
        matchFilter.tenantId = vals.length === 1 ? vals[0] : { $in: vals };
      } else if (role === 'inspector') {
        matchFilter.createdBy = new mongoose.Types.ObjectId(userId);
      } else {
        const vals = getTenantValues(userTenantId);
        matchFilter.tenantId = vals.length === 1 ? vals[0] : { $in: vals };
      }
    }

    if (formId) {
      matchFilter.questionId = formId;
    }

    // Date filtering - handle inclusive days and IST timezone boundaries
    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        const s = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`);
        matchFilter.createdAt.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`);
        matchFilter.createdAt.$lte = e;
      }
    }

    // Fetch all relevant responses (capped with maxTimeMS to prevent server blocking)
    console.log('getInspectorSummary - matchFilter:', JSON.stringify(matchFilter, null, 2));
    const responses = await Response.find(matchFilter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .maxTimeMS(15000)
      .select('_id questionId formId status answers chassisNumber createdBy submittedBy createdAt biwReview tenantId isDispatched')
      .lean();
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

        if (r.review?.status || r.review?.reviewOption) {
          const rs = String(r.review.status || r.review.reviewOption).toLowerCase();
          if (rs.includes('reject')) isRejected = true;
          else if (rs.includes('rework')) isRework = true;
          else if (rs.includes('accept') || rs.includes('ok')) isAccepted = true;
        }
        if (r.status) {
          const st = String(r.status).toLowerCase();
          if (st.includes('reject')) isRejected = true;
          else if (st.includes('rework')) isRework = true;
        }

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

    // First, lookup all users matching submitter names across these responses
    const submitterNames = [...new Set(
      responses
        .map(r => (r.submittedBy || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(n => n && n.toLowerCase() !== 'excel import' && n.toLowerCase() !== 'anonymous')
    )];

    let submitterUsers = [];
    if (submitterNames.length > 0) {
      const orClauses = [];
      submitterNames.forEach(name => {
        const cleanLower = name.toLowerCase();
        orClauses.push({ email: cleanLower });
        orClauses.push({ username: { $regex: new RegExp(`^${name}$`, 'i') } });
        orClauses.push({ $expr: { $eq: [{ $toLower: { $concat: ['$firstName', ' ', '$lastName'] } }, cleanLower] } });
        orClauses.push({ $expr: { $eq: [{ $toLower: { $concat: ['$firstName', '$lastName'] } }, cleanLower.replace(/\s+/g, '')] } });

        const parts = name.split(' ').filter(Boolean);
        if (parts.length >= 2) {
          const first = parts.slice(0, -1).join(' ');
          const last = parts[parts.length - 1];
          orClauses.push({
            firstName: { $regex: new RegExp(`^${first}`, 'i') },
            lastName: { $regex: new RegExp(`^${last}`, 'i') }
          });
        }
      });
      submitterUsers = await User.find({ $or: orClauses }).lean();
    }

    const nameToUserMap = {};
    submitterUsers.forEach(u => {
      const fn = `${u.firstName || ''} ${u.lastName || ''}`.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (fn) nameToUserMap[fn] = u;
      if (u.username) nameToUserMap[u.username.toLowerCase()] = u;
      if (u.email) nameToUserMap[u.email.toLowerCase()] = u;
      if (u.firstName) nameToUserMap[u.firstName.toLowerCase()] = u;
    });

    // Now aggregate per inspector and date
    const inspectorData = {};
    for (const r of responses) {
      const rawSub = (r.submittedBy || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      let matchedInspUser = null;
      if (rawSub && rawSub.toLowerCase() !== 'excel import') {
        matchedInspUser = nameToUserMap[rawSub.toLowerCase()];
      }

      const inspectorId = matchedInspUser ? matchedInspUser._id.toString() : (r.createdBy?.toString() || rawSub || 'unknown');
      const inspectorName = matchedInspUser
        ? `${matchedInspUser.firstName} ${matchedInspUser.lastName}`.trim()
        : (rawSub || 'Unknown Inspector');

      if (!inspectorId || inspectorId === 'unknown') continue;

      // Extract date string YYYY-MM-DD in IST (Asia/Kolkata)
      const rawDate = r.createdAt ? new Date(r.createdAt) : new Date();
      const validTime = !isNaN(rawDate.getTime()) ? rawDate.getTime() : Date.now();
      const istDate = new Date(validTime + (5.5 * 60 * 60 * 1000));
      const dateIST = istDate.toISOString().split('T')[0];
      const formId = r.questionId?.toString() || 'unknown';
      const key = `${inspectorId}_${dateIST}_${formId}`;

      if (!inspectorData[key]) {
        inspectorData[key] = {
          userId: inspectorId,
          inspectorName: inspectorName,
          matchedUser: matchedInspUser,
          date: dateIST,
          formId: formId,
          tenantId: matchedInspUser?.tenantId || r.tenantId,
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
    const userIds = [...new Set(entryKeys.map(k => inspectorData[k].userId).filter(id => mongoose.Types.ObjectId.isValid(id)))];
    const formIdsToFetch = [...new Set(entryKeys.map(k => inspectorData[k].formId))].filter(id => id !== 'unknown');

    const users = await User.find({ _id: { $in: userIds } }).lean();
    const fetchedForms = await Form.find({
      $or: [
        { id: { $in: formIdsToFetch } },
        { _id: { $in: formIdsToFetch.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
      ]
    }).lean();

    const tenantIds = [...new Set([...users.map(u => u.tenantId), ...submitterUsers.map(u => u.tenantId)].filter(Boolean))];
    const tenants = await Tenant.find({ _id: { $in: tenantIds } }).lean();
    const shifts = await Shift.find({ tenantId: { $in: tenantIds }, isActive: true }).lean();

    for (const key of entryKeys) {
      const stats = inspectorData[key];
      const user = users.find(u => u._id.toString() === stats.userId) || stats.matchedUser;

      const tenant = user ? tenants.find(t => t._id.toString() === user.tenantId?.toString()) : null;
      const shift = user ? shifts.find(s => s.assignedInspectors.some(id => id.toString() === stats.userId)) : null;
      const formInfo = fetchedForms.find(f => f.id === stats.formId || f._id.toString() === stats.formId);

      finalSummary.push({
        tenantName: tenant ? (tenant.companyName || tenant.name) : 'N/A',
        date: stats.date,
        shift: shift ? shift.displayName : 'N/A',
        formTitle: formInfo ? formInfo.title : 'N/A',
        qcInspector: user ? `${user.firstName} ${user.lastName}`.trim() : (stats.inspectorName || 'Unknown Inspector'),
        role: user ? user.role : 'inspector',
        username: user ? user.username : '',
        email: user ? user.email : '',
        isActive: user ? user.isActive : true,
        status: user ? user.status : 'active',
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

    const responsePayload = {
      success: true,
      data: {
        summary: finalSummary,
        allStatuses
      }
    };
    appCache.set(cacheKey, responsePayload, 180);
    res.json(responsePayload);
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
}) => JSON.stringify({ v: 'v29', tenantKey, startDate, endDate, formId, queryTenantId, page, limit });

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
    const { startDate, endDate, formId, formIds: queryFormIds, tenantId: queryTenantId } = req.query;
    const rawFormIds = queryFormIds || formId;
    const formIdList = rawFormIds
      ? (Array.isArray(rawFormIds) ? rawFormIds : String(rawFormIds).split(',')).map(s => s.trim()).filter(Boolean)
      : [];
    const { role, tenantId: userTenantId, _id: userId } = req.user;

    // ── Pagination params ────────────────────────────────────────────────
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    let start = null;
    let end = null;
    if (startDate) {
      const datePart = typeof startDate === 'string' && startDate.includes('T') ? startDate.split('T')[0] : startDate;
      start = new Date(`${datePart}T00:00:00.000Z`);
      if (isNaN(start.getTime())) start = new Date(0);
    } else {
      start = new Date(0);
    }
    if (endDate) {
      const datePart = typeof endDate === 'string' && endDate.includes('T') ? endDate.split('T')[0] : endDate;
      end = new Date(`${datePart}T23:59:59.999Z`);
      if (isNaN(end.getTime())) end = new Date();
    } else {
      end = new Date();
    }

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
      formId: formIdList.length > 0 ? formIdList.slice().sort().join(',') : null,
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

    let formIdVariants = null;
    let formDocs = [];
    let formDoc = null;
    let sharedWithTenants = [];
    let chassisTenantAssignments = [];

    const formLookupPromise = formIdList.length > 0
      ? Form.find({
        $or: [
          { id: { $in: formIdList } },
          ...(formIdList.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => ({ _id: id }))),
          { parentFormId: { $in: formIdList } }
        ],
      })
        .select('id _id tenantId sharedWithTenants chassisTenantAssignments sections parentFormId')
        .maxTimeMS(30000)
        .lean()
      : Promise.resolve([]);

    let [users, formLookupResult] = await Promise.all([
      User.find(usersQuery)
        .populate('tenantId', 'name companyName')
        .select('firstName lastName username email role tenantId isActive status')
        .maxTimeMS(30000)
        .lean(),
      formLookupPromise,
    ]);

    console.log(`[Performance Table] Found ${users.length} users from current tenant(s)`);

    if (formIdList.length > 0) {
      formDocs = formLookupResult || [];
      const matchedParents = formDocs.map(f => f._id?.toString() || f.id).filter(Boolean);
      const childDocs = matchedParents.length > 0 ? await Form.find({
        $or: [
          { parentFormId: { $in: matchedParents } },
          { parentFormId: { $in: formIdList } }
        ]
      }).select('id _id tenantId sharedWithTenants chassisTenantAssignments sections parentFormId').lean() : [];

      const combinedDocs = [...formDocs, ...childDocs];
      formDocs = combinedDocs;
      formDoc = combinedDocs[0] || null;
      formIdVariants = [];
      combinedDocs.forEach(f => {
        if (f.id) formIdVariants.push(f.id);
        if (f._id) formIdVariants.push(f._id.toString());
        (f.sharedWithTenants || []).forEach(id => sharedWithTenants.push(id.toString()));
        if (f.chassisTenantAssignments) chassisTenantAssignments.push(...f.chassisTenantAssignments);
      });
      // Fallback: if not found in db directly, still use the passed ids
      formIdList.forEach(id => {
        if (!formIdVariants.includes(id)) formIdVariants.push(id);
      });
    } else {
      // When no specific formId is passed, resolve all accessible forms for the user/tenant
      // (base forms directly accessible to tenant + cross-tenant child forms like Saify paint forms)
      const formQuery = {};
      if (role === 'superadmin' && !queryTenantId) {
        // Superadmin sees all forms
      } else if (targetTenantId || userTenantId) {
        const effectiveTId = targetTenantId || userTenantId;
        const tIdObj = mongoose.Types.ObjectId.isValid(effectiveTId)
          ? new mongoose.Types.ObjectId(effectiveTId)
          : effectiveTId;

        formQuery.$or = [
          { tenantId: tIdObj },
          { tenantId: effectiveTId.toString() },
          { isGlobal: true },
          { sharedWithTenants: effectiveTId.toString() },
          { sharedWithTenants: tIdObj },
          { 'chassisTenantAssignments.assignedTenants': effectiveTId.toString() }
        ];
      }

      const baseForms = await Form.find(formQuery)
        .select('id _id tenantId sharedWithTenants chassisTenantAssignments sections parentFormId childForms')
        .maxTimeMS(30000)
        .lean();

      const linkedChildIds = [];
      baseForms.forEach(f => {
        (f.childForms || []).forEach(cf => {
          const cfId = typeof cf === 'string' ? cf : (cf.formId || cf.id || cf._id);
          if (cfId) linkedChildIds.push(cfId.toString());
        });
        if (f.parentFormId) {
          linkedChildIds.push(f.parentFormId.toString());
        }
      });

      const childDocs = linkedChildIds.length > 0 ? await Form.find({
        $or: [
          { id: { $in: linkedChildIds } },
          { _id: { $in: linkedChildIds.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id)) } }
        ]
      }).select('id _id tenantId sharedWithTenants chassisTenantAssignments sections parentFormId').maxTimeMS(30000).lean() : [];

      // Deduplicate combined docs by MongoDB _id to prevent double-counting
      const seenDocIds = new Set();
      const combinedDocs = [...baseForms, ...childDocs].filter(f => {
        const docId = f._id?.toString();
        if (!docId || seenDocIds.has(docId)) return false;
        seenDocIds.add(docId);
        return true;
      });
      formDocs = combinedDocs;
      formDoc = combinedDocs[0] || null;
      formIdVariants = [];
      combinedDocs.forEach(f => {
        if (f.id) formIdVariants.push(f.id);
        if (f._id) formIdVariants.push(f._id.toString());
        (f.sharedWithTenants || []).forEach(id => sharedWithTenants.push(id.toString()));
        if (f.chassisTenantAssignments) chassisTenantAssignments.push(...f.chassisTenantAssignments);
      });
    }

    // Preload form -> tenantId map for accurate plant-level accountability
    const formTenantMap = new Map();
    if (formDocs && formDocs.length > 0) {
      formDocs.forEach(f => {
        const tId = f.tenantId ? f.tenantId.toString() : null;
        if (f.id && tId) formTenantMap.set(f.id, tId);
        if (f._id && tId) formTenantMap.set(f._id.toString(), tId);
      });
    }

    // Preload all tenants for fast plant name resolution
    const allTenantsList = await Tenant.find({}).select('_id name companyName').lean();
    const tenantNameMap = new Map();
    allTenantsList.forEach(t => {
      tenantNameMap.set(t._id.toString(), t.name || t.companyName || 'Unknown Plant');
    });

    // Build response query — must exclude section-submit responses to match getQualitySummary
    const responseBaseFilter = {
      createdAt: { $gte: start, $lte: end },
      isSectionSubmit: { $ne: true }
    };

    if (formIdVariants && formIdVariants.length > 0) {
      responseBaseFilter.questionId = { $in: formIdVariants };
    } else {
      Object.assign(responseBaseFilter, tenantFilter);
    }

    // ── Fetch all responses in date range (up to 10,000) for full per-user aggregation ──
    const [totalResponsesInRange, allResponses, aggregatedInspectors] = await Promise.all([
      Response.countDocuments(responseBaseFilter).maxTimeMS(30000),
      Response.find(responseBaseFilter)
        .select('createdBy submittedBy isDispatched biwReview review tvsReview status chassisNumber questionId createdAt id _id tenantId')
        .limit(10000)
        .maxTimeMS(30000)
        .lean(),
      Response.aggregate([
        { $match: responseBaseFilter },
        {
          $group: {
            _id: { $trim: { input: { $ifNull: ['$submittedBy', 'Unknown Submitter'] } } },
            totalSubmitted: { $sum: 1 },
            defectCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                      { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                      { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                      {
                        $anyElementTrue: {
                          $map: {
                            input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                            as: 'ans',
                            in: {
                              $regexMatch: {
                                input: {
                                  $toLower: {
                                    $ifNull: [
                                      '$$ans.v.status',
                                      {
                                        $cond: [
                                          { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                          '$$ans.v',
                                          ''
                                        ]
                                      }
                                    ]
                                  }
                                },
                                regex: 'rework|rejected|defect|fail|not ok'
                              }
                            }
                          }
                        }
                      }
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
                  {
                    $or: [
                      { $eq: ['$biwReview.status', 'Reworked'] },
                      { $in: ['$review.status', ['Rework', 'Reworked']] },
                      { $in: ['$review.reviewOption', ['Rework', 'Reworked']] },
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework' } }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            reworkAcceptedCount: {
              $sum: {
                $cond: [
                  { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework accept|rework complete' } },
                  1,
                  0
                ]
              }
            },
            rejectedCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$biwReview.status', 'Rejected'] },
                      { $eq: ['$review.status', 'Rejected'] },
                      { $eq: ['$review.reviewOption', 'Rejected'] },
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'reject' } }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            dispatched: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$isDispatched', true] },
                      { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            biwTotalReviewed: {
              $sum: { $cond: [{ $in: ['$biwReview.status', ['Accepted', 'Rejected', 'Reworked']] }, 1, 0] }
            },
            biwAccepted: {
              $sum: { $cond: [{ $eq: ['$biwReview.status', 'Accepted'] }, 1, 0] }
            },
            biwRejected: {
              $sum: { $cond: [{ $eq: ['$biwReview.status', 'Rejected'] }, 1, 0] }
            },
            biwReworked: {
              $sum: { $cond: [{ $in: ['$biwReview.status', ['Rejected', 'Reworked']] }, 1, 0] }
            },
            tvsTotalReviewed: {
              $sum: {
                $cond: [
                  { $or: [{ $in: ['$review.status', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }] },
                  1,
                  0
                ]
              }
            },
            tvsAccepted: {
              $sum: {
                $cond: [
                  { $or: [{ $eq: ['$review.status', 'Accepted'] }, { $eq: ['$review.reviewOption', 'Accepted'] }] },
                  1,
                  0
                ]
              }
            },
            tvsRejected: {
              $sum: {
                $cond: [
                  { $or: [{ $eq: ['$review.status', 'Rejected'] }, { $eq: ['$review.reviewOption', 'Rejected'] }] },
                  1,
                  0
                ]
              }
            },
            tvsReworked: {
              $sum: {
                $cond: [
                  { $or: [{ $in: ['$review.status', ['Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Rework', 'Reworked']] }] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true })
    ]);

    console.log(`[Performance Table] Found ${allResponses.length} responses (of ${totalResponsesInRange} total in range)`);

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

    // Also fetch users matching submittedBy names from responses so that accountability
    // is attributed to the actual inspector rather than the user account that submitted/created the record.
    const submitterNamesFromResponses = [...new Set(
      filteredResponses
        .map(r => (r.submittedBy || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(n => n && n.toLowerCase() !== 'excel import' && n.toLowerCase() !== 'anonymous')
    )];

    if (submitterNamesFromResponses.length > 0) {
      try {
        const allPotentialUsers = await User.find({})
          .select('firstName lastName username email role tenantId isActive status performanceScore totalReviews acceptedCount rejectedCount reworkCount')
          .populate('tenantId', 'name companyName')
          .maxTimeMS(10000)
          .lean();

        const existingIds = new Set(users.map(u => u._id.toString()));
        const matchedNewUsers = [];

        submitterNamesFromResponses.forEach(name => {
          const cleanLower = name.toLowerCase();
          const found = allPotentialUsers.find(u => {
            const fullName = `${u.firstName || ''} ${u.lastName || ''}`.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            return (
              (fullName && fullName === cleanLower) ||
              (u.email && u.email.toLowerCase() === cleanLower) ||
              (u.username && u.username.toLowerCase() === cleanLower) ||
              (u.firstName && u.firstName.toLowerCase() === cleanLower)
            );
          });
          if (found && !existingIds.has(found._id.toString())) {
            existingIds.add(found._id.toString());
            matchedNewUsers.push(found);
          }
        });

        if (matchedNewUsers.length > 0) {
          users = [...users, ...matchedNewUsers];
          console.log(`[Performance Table] Added ${matchedNewUsers.length} users matched from submittedBy names in memory`);
        }
      } catch (sErr) {
        console.error('Error fetching users by submittedBy names:', sErr);
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

    const reviews = await Review.find(reviewQuery)
      .select('_id responseId response_id submitterId status reviewOption revieweeId createdBy userId submittedBy')
      .maxTimeMS(15000)
      .lean();
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

    // Process reviews indexed by responseId so that review outcomes (Accepted,
    // Rejected, Reworked) are credited to the INSPECTOR who submitted the response,
    // rather than the reviewer who performed the review.
    const reviewsByResponseId = new Map();
    reviews.forEach(review => {
      const rId = String(review.responseId || review.response_id || review.response || '');
      if (rId && !reviewsByResponseId.has(rId)) {
        reviewsByResponseId.set(rId, review);
      }
    });

    console.log(`[Performance Table] Reviews by response ID map has ${reviewsByResponseId.size} entries`);

    // Helper: Determine inspection status
    const getInspectionStatus = (response) => {
      let isRework = false;
      let isAccepted = false;
      let isRejected = false;
      let foundStatus = null;

      // Check TVS Review (by response ID in reviewsByResponseId or on response document)
      const rId1 = response._id ? response._id.toString() : '';
      const rId2 = response.id ? String(response.id) : '';
      const tvsReview = reviewsByResponseId.get(rId1) || reviewsByResponseId.get(rId2) || response.tvsReview || response.review;
      const tvsStatus = tvsReview?.reviewOption || tvsReview?.status;
      if (tvsStatus) {
        const ts = String(tvsStatus).toLowerCase();
        if (ts.includes('reject')) isRejected = true;
        else if (ts.includes('rework')) isRework = true;
        else if (ts.includes('accept') || ts.includes('ok')) isAccepted = true;
      }

      if (response.biwReview?.status) {
        const bs = String(response.biwReview.status).toLowerCase();
        if (bs === 'accepted') isAccepted = true;
        else if (bs === 'rejected') isRejected = true;
        else if (bs === 'reworked' || bs === 'rework') isRework = true;
      }

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

          if (sl === 'rework' || sl === 'reworked' || sl.includes('re-rework') || sl === 'defect' || sl === 'not ok') {
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
          } else if (sl === 'rejected' || sl === 'no' || sl === 'fail') {
            isRejected = true;
          } else {
            foundStatus = s;
          }
        });
      }

      if (isRejected) return 'Rejected';
      if (isRework) return 'Rework QC Pending';
      if (isAccepted) return 'Direct Ok';

      if (response.status && response.status.toLowerCase() !== 'pending') {
        const rsl = response.status.toLowerCase();
        if (rsl.includes('reject')) return 'Rejected';
        if (rsl.includes('rework')) return 'Rework QC Pending';
        return response.status;
      }

      if (foundStatus) return foundStatus;
      return 'Direct Ok';
    };

    // Initialize stats for all users
    const userStatsMap = new Map();

    Object.values(userMap).forEach(user => {
      const uId = user._id.toString();
      const tIdStr = user.tenantId?._id?.toString() || user.tenantId?.toString() || '';
      const tName = (tIdStr && tenantNameMap.get(tIdStr)) || user.tenantId?.name || user.tenantId?.companyName || 'Unknown Plant';
      userStatsMap.set(uId, {
        userId: uId,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        userEmail: user.email || '',
        userRole: user.role || 'inspector',
        tenantId: tIdStr,
        tenantName: tName,
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
        biwTotalReviewed: 0,
        biwReviewPending: 0,
        biwAccepted: 0,
        biwRejected: 0,
        biwReworked: 0,
        tvsTotalReviewed: 0,
        tvsReviewPending: 0,
        tvsAccepted: 0,
        tvsRejected: 0,
        tvsReworked: 0,
        performanceScore: 0,
        responses: []
      });
    });

    // Process responses based on form submission accountability (submittedBy).
    filteredResponses.forEach(response => {
      // Normalize whitespace including non-breaking spaces
      const rawSubmittedBy = (response.submittedBy || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      let matchedUser = null;

      if (rawSubmittedBy && rawSubmittedBy.toLowerCase() !== 'excel import') {
        const rawLower = rawSubmittedBy.toLowerCase();
        matchedUser = users.find(u => {
          const fullName = `${u.firstName || ''} ${u.lastName || ''}`.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
          return (
            (fullName && fullName === rawLower) ||
            (u.email && u.email.toLowerCase() === rawLower) ||
            (u.username && u.username.toLowerCase() === rawLower) ||
            (u.firstName && u.firstName.toLowerCase() === rawLower)
          );
        });
      }

      // If submittedBy did not match any user in DB, but createdBy exists and submittedBy was empty / excel import
      if (!matchedUser && (!rawSubmittedBy || rawSubmittedBy.toLowerCase() === 'excel import') && response.createdBy) {
        matchedUser = userMap[response.createdBy.toString()];
      }

      const userId = matchedUser ? matchedUser._id.toString() : (rawSubmittedBy || 'unknown');
      const userName = matchedUser
        ? `${matchedUser.firstName} ${matchedUser.lastName}`.trim()
        : (rawSubmittedBy || 'Unknown User');

      // Resolve which plant / tenant this response belongs to
      let respTenantId = response.tenantId ? response.tenantId.toString() : null;
      if (!respTenantId && response.questionId) {
        respTenantId = formTenantMap.get(response.questionId.toString()) || null;
      }
      if (!respTenantId) {
        respTenantId = matchedUser?.tenantId ? (matchedUser.tenantId._id?.toString() || matchedUser.tenantId.toString()) : (userTenantId ? userTenantId.toString() : 'unknown');
      }
      const respTenantName = (respTenantId && tenantNameMap.get(respTenantId))
        || (matchedUser?.tenantId?.name || matchedUser?.tenantId?.companyName)
        || (respTenantId === userTenantId?.toString() ? (req.user?.tenantName || 'Main Plant') : 'Unknown Plant');

      // Single entry per inspector/user to ensure exact match with Quality Summary / Pie Chart
      let statsKey = matchedUser ? matchedUser._id.toString() : null;
      if (!statsKey && rawSubmittedBy) {
        const rawLower = rawSubmittedBy.toLowerCase();
        for (const [k, s] of userStatsMap) {
          if ((s.userName || '').toLowerCase() === rawLower) {
            statsKey = k;
            break;
          }
        }
      }
      if (!statsKey) {
        statsKey = userId || 'unknown';
      }

      if (!userStatsMap.has(statsKey)) {
        userStatsMap.set(statsKey, {
          userId: statsKey,
          userName: userName,
          userEmail: matchedUser?.email || '',
          userRole: matchedUser?.role || 'inspector',
          tenantId: respTenantId,
          tenantName: respTenantName,
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
          biwTotalReviewed: 0,
          biwReviewPending: 0,
          biwAccepted: 0,
          biwRejected: 0,
          biwReworked: 0,
          tvsTotalReviewed: 0,
          tvsReviewPending: 0,
          tvsAccepted: 0,
          tvsRejected: 0,
          tvsReworked: 0,
          performanceScore: 0,
          responses: []
        });
      } else {
        const existingEntry = userStatsMap.get(statsKey);
        if (respTenantName && respTenantName !== 'Unknown Plant' && (!existingEntry.tenantName || existingEntry.tenantName === 'Unknown Tenant' || existingEntry.tenantName === 'Unknown Plant')) {
          existingEntry.tenantName = respTenantName;
          if (respTenantId) existingEntry.tenantId = respTenantId;
        }
      }

      const stats = userStatsMap.get(statsKey);
      stats.totalSubmitted++;
      stats.responses.push(response);

      const status = getInspectionStatus(response);
      if (status === 'Direct Ok') stats.directOk++;
      else if (status === 'Rework QC Pending') stats.reworkQcPending++;
      else if (status === 'Rejected') stats.rejected++;

      // Dispatched count is credited to the inspector who submitted the inspection form,
      // regardless of who clicked the dispatch action.
      if (response.isDispatched) {
        stats.dispatched++;
      } else {
        const dispatchableStatuses = ['Direct Ok', 'Rework QC Completed', 'Accepted'];
        if (dispatchableStatuses.includes(status)) {
          stats.dispatchPending++;
        }
      }

      // Review outcomes are credited to the submitter of this inspected chassis
      const rId1 = response._id ? response._id.toString() : '';
      const rId2 = response.id ? String(response.id) : '';

      // 1. BIW Review outcomes (from response.biwReview)
      const biwStatus = response.biwReview?.status;
      if (biwStatus) {
        const bsLower = String(biwStatus).toLowerCase();
        if (
          bsLower.includes('accept') ||
          bsLower.includes('direct ok') ||
          bsLower.includes('ok') ||
          bsLower === 'verified'
        ) {
          stats.biwAccepted++;
          stats.accepted++;
          stats.biwTotalReviewed++;
          stats.totalReviewed++;
        } else if (bsLower.includes('reject')) {
          stats.biwRejected++;
          stats.rejectedReview++;
          stats.biwTotalReviewed++;
          stats.totalReviewed++;
        } else if (bsLower.includes('rework')) {
          stats.biwReworked++;
          stats.reworked++;
          stats.biwTotalReviewed++;
          stats.totalReviewed++;
        }
      }

      // 2. TVS Review outcomes (from Review collection or response.tvsReview / response.review)
      const tvsReview = reviewsByResponseId.get(rId1) || reviewsByResponseId.get(rId2) || response.tvsReview || response.review;
      const tvsStatus = tvsReview?.reviewOption || tvsReview?.status;

      if (tvsStatus) {
        const tsLower = String(tvsStatus).toLowerCase();
        if (
          tsLower.includes('accept') ||
          tsLower.includes('direct ok') ||
          tsLower.includes('ok') ||
          tsLower === 'verified'
        ) {
          stats.tvsAccepted++;
          stats.tvsTotalReviewed++;
        } else if (tsLower.includes('reject')) {
          stats.tvsRejected++;
          stats.tvsTotalReviewed++;
        } else if (tsLower.includes('rework')) {
          stats.tvsReworked++;
          stats.tvsTotalReviewed++;
        }
      }
    });

    // Build lookup from inspector DB aggregation
    const aggMap = new Map();
    (aggregatedInspectors || []).forEach(ai => {
      const nameKey = (ai._id || '').trim();
      if (nameKey) {
        aggMap.set(nameKey, ai);
        aggMap.set(nameKey.toLowerCase(), ai);
      }
    });

    // Calculate final metrics strictly reconciled with DB aggregation truth
    for (const [userId, stats] of userStatsMap) {
      const matchAgg = aggMap.get(stats.userName) || aggMap.get((stats.userName || '').toLowerCase());
      if (matchAgg) {
        stats.totalSubmitted = matchAgg.totalSubmitted || stats.totalSubmitted;
        stats.defectCount = matchAgg.defectCount || 0;
        stats.directOk = Math.max(0, stats.totalSubmitted - stats.defectCount);
        stats.reworkQcPending = stats.defectCount;
        stats.reworkQcCompleted = matchAgg.reworkAcceptedCount || 0;
        stats.rejected = matchAgg.rejectedCount || 0;
        stats.dispatched = matchAgg.dispatched !== undefined ? matchAgg.dispatched : (stats.dispatched || 0);
        stats.dispatchPending = Math.max(0, stats.directOk + stats.reworkQcCompleted - stats.dispatched);
        stats.biwTotalReviewed = matchAgg.biwTotalReviewed !== undefined ? matchAgg.biwTotalReviewed : (stats.biwTotalReviewed || 0);
        stats.biwAccepted = matchAgg.biwAccepted !== undefined ? matchAgg.biwAccepted : (stats.biwAccepted || 0);
        stats.biwRejected = matchAgg.biwRejected !== undefined ? matchAgg.biwRejected : (stats.biwRejected || 0);
        stats.biwReworked = matchAgg.biwReworked !== undefined ? matchAgg.biwReworked : (stats.biwReworked || 0);
        stats.tvsTotalReviewed = matchAgg.tvsTotalReviewed !== undefined ? matchAgg.tvsTotalReviewed : (stats.tvsTotalReviewed || 0);
        stats.tvsAccepted = matchAgg.tvsAccepted !== undefined ? matchAgg.tvsAccepted : (stats.tvsAccepted || 0);
        stats.tvsRejected = matchAgg.tvsRejected !== undefined ? matchAgg.tvsRejected : (stats.tvsRejected || 0);
        stats.tvsReworked = matchAgg.tvsReworked !== undefined ? matchAgg.tvsReworked : (stats.tvsReworked || 0);
      } else {
        stats.dispatchPending = Math.max(0, stats.directOk + stats.reworkQcCompleted - stats.dispatched);
      }

      stats.biwReviewPending = Math.max(0, stats.totalSubmitted - stats.biwTotalReviewed);
      stats.reviewPending = stats.biwReviewPending;
      stats.tvsReviewPending = Math.max(0, stats.totalSubmitted - stats.tvsTotalReviewed);

      const totalReviewed = stats.biwTotalReviewed + stats.tvsTotalReviewed;
      const totalAccepted = stats.biwAccepted + stats.tvsAccepted;

      if (totalReviewed > 0) {
        stats.performanceScore = Math.round((totalAccepted / totalReviewed) * 100);
      } else if (stats.totalSubmitted > 0) {
        const defects = stats.reworkQcPending + stats.rejected;
        stats.performanceScore = Math.round((Math.max(0, stats.totalSubmitted - defects) / stats.totalSubmitted) * 100);
      } else {
        stats.performanceScore = 0;
      }
    }

    // Add any submitters from aggregatedInspectors not yet in userStatsMap
    for (const ai of (aggregatedInspectors || [])) {
      const nameKey = (ai._id || '').trim();
      if (!nameKey || nameKey.toLowerCase() === 'unknown submitter') continue;
      const lower = nameKey.toLowerCase();
      const existing = Array.from(userStatsMap.values()).find(s => (s.userName || '').toLowerCase() === lower);
      if (!existing && ai.totalSubmitted > 0) {
        const u = users.find(u => `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase() === lower || u.username?.toLowerCase() === lower);
        const sampleResp = allResponses.find(r => (r.submittedBy || '').trim().toLowerCase() === lower);
        const respTId = sampleResp?.tenantId?.toString() || (sampleResp?.questionId && formTenantMap.get(sampleResp.questionId.toString()));
        const uTId = u?.tenantId?._id?.toString() || u?.tenantId?.toString() || respTId;
        const tenantName = (uTId && tenantNameMap.get(uTId)) || u?.tenantId?.companyName || u?.tenantId?.name || 'Unknown Plant';
        const dOk = Math.max(0, ai.totalSubmitted - (ai.defectCount || 0));
        const disp = ai.dispatched || 0;
        const totalRev = (ai.biwTotalReviewed || 0) + (ai.tvsTotalReviewed || 0);
        const totalAcc = (ai.biwAccepted || 0) + (ai.tvsAccepted || 0);
        const pScore = totalRev > 0 ? Math.round((totalAcc / totalRev) * 100) : (ai.totalSubmitted > 0 ? Math.round((dOk / ai.totalSubmitted) * 100) : 0);

        userStatsMap.set(`insp_${nameKey}`, {
          userId: u?._id?.toString() || `insp_${nameKey}`,
          userName: nameKey,
          userEmail: u?.email || '',
          userRole: u?.role || 'inspector',
          tenantName: tenantName,
          totalSubmitted: ai.totalSubmitted,
          directOk: dOk,
          reworkQcPending: ai.defectCount || 0,
          reworkQcCompleted: ai.reworkAcceptedCount || 0,
          rejected: ai.rejectedCount || 0,
          dispatched: disp,
          dispatchPending: Math.max(0, dOk + (ai.reworkAcceptedCount || 0) - disp),
          biwTotalReviewed: ai.biwTotalReviewed || 0,
          biwAccepted: ai.biwAccepted || 0,
          biwRejected: ai.biwRejected || 0,
          biwReworked: ai.biwReworked || 0,
          biwReviewPending: Math.max(0, ai.totalSubmitted - (ai.biwTotalReviewed || 0)),
          reviewPending: Math.max(0, ai.totalSubmitted - (ai.biwTotalReviewed || 0)),
          tvsTotalReviewed: ai.tvsTotalReviewed || 0,
          tvsAccepted: ai.tvsAccepted || 0,
          tvsRejected: ai.tvsRejected || 0,
          tvsReworked: ai.tvsReworked || 0,
          tvsReviewPending: Math.max(0, ai.totalSubmitted - (ai.tvsTotalReviewed || 0)),
          performanceScore: pScore,
          responses: []
        });
      }
    }

    // Format final table data
    const formTenantId = formDoc?.tenantId ? formDoc.tenantId.toString() : (userTenantId ? userTenantId.toString() : null);
    const tableData = Array.from(userStatsMap.values())
      .filter(stats => stats.totalSubmitted > 0 || stats.totalReviewed > 0)
      .map(stats => {
        const user = userMap[stats.userId];

        let displayName = stats.userName;
        let displayEmail = stats.userEmail;
        let displayRole = stats.userRole;
        // Keep stats.tenantName as the plant where inspections were performed
        let tenantName = stats.tenantName || (user ? (user.tenantId?.name || user.tenantId?.companyName) : 'Cross-Tenant User');

        if (user) {
          displayName = `${user.firstName} ${user.lastName}`;
          displayEmail = user.email || '';
          displayRole = user.role || 'inspector';
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

          // BIW Review
          biwTotalReviewed: stats.biwTotalReviewed || 0,
          biwReviewPending: stats.biwReviewPending || 0,
          biwAccepted: stats.biwAccepted || 0,
          biwRejected: stats.biwRejected || 0,
          biwReworked: stats.biwReworked || 0,

          // Backward compatibility aliases
          totalReviewed: stats.biwTotalReviewed || 0,
          reviewPending: stats.biwReviewPending || 0,
          accepted: stats.biwAccepted || 0,
          rejectedReview: stats.biwRejected || 0,
          reworked: stats.biwReworked || 0,

          // TVS Review
          tvsTotalReviewed: stats.tvsTotalReviewed || 0,
          tvsReviewPending: stats.tvsReviewPending || 0,
          tvsAccepted: stats.tvsAccepted || 0,
          tvsRejected: stats.tvsRejected || 0,
          tvsReworked: stats.tvsReworked || 0,

          performanceScore: stats.performanceScore || 0
        };
      });

    tableData.sort((a, b) => b.performanceScore - a.performanceScore);

    const summary = {
      totalUsers: tableData.length,
      totalSubmissions: tableData.reduce((sum, row) => sum + row.totalSubmitted, 0),
      totalDispatched: tableData.reduce((sum, row) => sum + row.dispatched, 0),
      totalReviewed: tableData.reduce((sum, row) => sum + row.totalReviewed, 0),
      totalBiwReviewed: tableData.reduce((sum, row) => sum + row.biwTotalReviewed, 0),
      totalTvsReviewed: tableData.reduce((sum, row) => sum + row.tvsTotalReviewed, 0),
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
    const { formId, formIds, startDate, endDate, tenantId: queryTenantId } = req.query;
    const { role, tenantId: userTenantId } = req.user;

    // Parse date objects safely once at function level (normalized to full day UTC boundaries)
    let startObj = null;
    let endObj = null;
    if (startDate) {
      const datePart = typeof startDate === 'string' && startDate.includes('T') ? startDate.split('T')[0] : startDate;
      startObj = new Date(`${datePart}T00:00:00.000Z`);
      if (isNaN(startObj.getTime())) startObj = null;
    }
    if (endDate) {
      const datePart = typeof endDate === 'string' && endDate.includes('T') ? endDate.split('T')[0] : endDate;
      endObj = new Date(`${datePart}T23:59:59.999Z`);
      if (isNaN(endObj.getTime())) endObj = null;
    }

    // Parse formIds (can be an array, comma-separated string, or single formId)
    const rawFormInput = formIds || formId;
    let selectedFormIdList = [];
    if (rawFormInput && rawFormInput !== 'all') {
      if (Array.isArray(rawFormInput)) {
        selectedFormIdList = rawFormInput.flatMap(id => String(id).split(',')).map(s => s.trim()).filter(Boolean);
      } else if (typeof rawFormInput === 'string') {
        selectedFormIdList = rawFormInput.split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    // ─── Cache check (3 minute TTL) ─────────────────────────────────────
    const formKeyForCache = selectedFormIdList.length > 0 ? [...selectedFormIdList].sort().join(',') : 'all';
    const cacheKey = `quality_summary_v28_${userTenantId || 'superadmin'}_${formKeyForCache}_${startDate || ''}_${endDate || ''}_${queryTenantId || ''}`;
    const shouldBypassCache = req.query.forceNetwork === 'true' || req.query.bypassCache === 'true' || req.headers?.['cache-control'] === 'no-cache';
    if (!shouldBypassCache) {
      const cached = appCache.get(cacheKey);
      if (cached) {
        console.log(`[Quality Summary] Cache HIT (${cacheKey}) - returning in ${Date.now() - startTimer}ms`);
        return res.json(cached);
      }
    }
    console.log(`[Quality Summary] Cache MISS or Bypassed (${cacheKey}) - computing from DB...`);

    // 1. Identify target tenant
    let targetTenantId = userTenantId;
    if (role === 'superadmin' && queryTenantId) {
      targetTenantId = queryTenantId;
    }

    // 2. Fetch accessible forms (cached in memory for 5 minutes)
    const formsMetaCacheKey = `forms_meta_v22_${targetTenantId || 'all'}`;
    let formsMeta = appCache.get(formsMetaCacheKey);

    if (!formsMeta || shouldBypassCache) {
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

      // 1. Fetch base forms directly accessible to tenant
      const baseForms = await Form.find(formQuery)
        .select('id _id title sections tenantId childForms parentFormId parentFormTitle isChildForm')
        .lean();

      // 2. Collect all linked child form IDs & parent form IDs
      const linkedChildIds = [];
      const accessibleParentIds = [];
      baseForms.forEach(f => {
        const fIds = [f.id, f._id ? f._id.toString() : ''].filter(Boolean);
        accessibleParentIds.push(...fIds);
        (f.childForms || []).forEach(cf => {
          const cfId = typeof cf === 'string' ? cf : (cf.formId || cf.id || cf._id);
          if (cfId) linkedChildIds.push(cfId.toString());
        });
        if (f.parentFormId) {
          linkedChildIds.push(f.parentFormId.toString());
        }
      });

      let additionalChildForms = [];
      const additionalObjIds = linkedChildIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      const parentObjIds = accessibleParentIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (linkedChildIds.length > 0 || accessibleParentIds.length > 0) {
        const extraQuery = {
          $or: [
            ...(linkedChildIds.length > 0 ? [
              { _id: { $in: additionalObjIds } },
              { id: { $in: linkedChildIds } }
            ] : []),
            ...(accessibleParentIds.length > 0 ? [
              { parentFormId: { $in: [...accessibleParentIds, ...parentObjIds] } },
              { 'childForms.formId': { $in: accessibleParentIds } }
            ] : [])
          ]
        };
        additionalChildForms = await Form.find(extraQuery)
          .select('id _id title sections tenantId childForms parentFormId parentFormTitle isChildForm')
          .lean();
      }

      const formMapById = new Map();
      baseForms.forEach(f => formMapById.set(f._id.toString(), f));
      additionalChildForms.forEach(f => formMapById.set(f._id.toString(), f));
      const accessibleForms = Array.from(formMapById.values());

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

      formsMeta = {
        accessibleForms,
        formTitleMap,
        formChassisQuestionMap,
        questionTitleMap,
        questionMetaMap
      };
      appCache.set(formsMetaCacheKey, formsMeta, 300); // 5 min TTL
    }

    const {
      accessibleForms,
      formTitleMap,
      formChassisQuestionMap,
      questionTitleMap,
      questionMetaMap
    } = formsMeta;

    // 2b. Compute or retrieve master inspection counts for all accessible forms (cached 5 min)
    const masterCountsKey = `master_form_counts_v22_${userTenantId || 'superadmin'}`;
    let masterFormCounts = appCache.get(masterCountsKey);

    if (!masterFormCounts) {
      const allAccessibleKeys = accessibleForms.flatMap(f => [f.id, f._id?.toString()]).filter(Boolean);
      const countAgg = await Response.aggregate([
        { $match: { questionId: { $in: allAccessibleKeys }, isSectionSubmit: { $ne: true } } },
        { $group: { _id: '$questionId', count: { $sum: 1 } } }
      ]);
      masterFormCounts = {};
      countAgg.forEach(c => {
        if (c._id) masterFormCounts[c._id.toString()] = c.count;
      });
      appCache.set(masterCountsKey, masterFormCounts, 300); // 5 min TTL
    }

    // 3. Build response filter
    let formKeys = [];
    if (selectedFormIdList.length > 0) {
      const matchedForms = accessibleForms.filter(
        f => selectedFormIdList.includes(f.id) || selectedFormIdList.includes(f._id.toString())
      );
      if (matchedForms.length > 0) {
        formKeys = matchedForms.flatMap(f => [f.id, f._id?.toString()]).filter(Boolean);
      } else {
        formKeys = selectedFormIdList;
      }
    } else {
      formKeys = accessibleForms.flatMap(f => [f.id, f._id?.toString()]).filter(Boolean);
    }

    const responseFilter = {
      questionId: { $in: formKeys },
      isSectionSubmit: { $ne: true }
    };

    // Guard: if no accessible forms found, return empty summary immediately
    if (formKeys.length === 0) {
      console.log(`[Quality Summary] No accessible forms found for tenant ${targetTenantId} - returning empty summary`);
      const emptyPayload = {
        success: true,
        data: {
          totalChecked: 0, totalAccepted: 0, totalDefects: 0, overallAcceptRate: 0, overallDefectRate: 0,
          totalRework1: 0, reworkAcceptedCount: 0, rejectedCount: 0, directOkCount: 0,
          totalDispatched: 0, pendingDispatch: 0, totalBiwReviewed: 0, biwAcceptCount: 0, biwRejectCount: 0,
          tvsReviewedCount: 0, tvsAcceptCount: 0, tvsRejectCount: 0, tvsReworkCount: 0, pendingTvsReview: 0,
          totalForms: 0, formBreakdown: [], inspectors: [], defectBreakdown: [], dailyTrends: [], rawResponses: []
        }
      };
      appCache.set(cacheKey, emptyPayload, 60);
      return res.json(emptyPayload);
    }

    if (startObj || endObj) {
      responseFilter.createdAt = {};
      if (startObj) responseFilter.createdAt.$gte = startObj;
      if (endObj) responseFilter.createdAt.$lte = endObj;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

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
                total30Count: {
                  $sum: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 1, 0] }
                },
                dispatched30Count: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$createdAt', thirtyDaysAgo] },
                          {
                            $or: [
                              { $eq: ['$isDispatched', true] },
                              { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                            ]
                          }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                defect30Count: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$createdAt', thirtyDaysAgo] },
                          {
                            $or: [
                              { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                              { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                              { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                              { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                              {
                                $anyElementTrue: {
                                  $map: {
                                    input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                    as: 'ans',
                                    in: {
                                      $regexMatch: {
                                        input: {
                                          $toLower: {
                                            $ifNull: [
                                              '$$ans.v.status',
                                              {
                                                $cond: [
                                                  { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                                  '$$ans.v',
                                                  ''
                                                ]
                                              }
                                            ]
                                          }
                                        },
                                        regex: 'rework|rejected|defect|fail|not ok'
                                      }
                                    }
                                  }
                                }
                              }
                            ]
                          }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                          {
                            $anyElementTrue: {
                              $map: {
                                input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                as: 'ans',
                                in: {
                                  $regexMatch: {
                                    input: {
                                      $toLower: {
                                        $ifNull: [
                                          '$$ans.v.status',
                                          {
                                            $cond: [
                                              { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                              '$$ans.v',
                                              ''
                                            ]
                                          }
                                        ]
                                      }
                                    },
                                    regex: 'rework|rejected|defect|fail|not ok'
                                  }
                                }
                              }
                            }
                          }
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
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Reworked'] },
                          { $in: ['$review.status', ['Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                reworkAcceptedCount: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework accept|rework complete' } },
                      1,
                      0
                    ]
                  }
                },
                rejectedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Rejected'] },
                          { $eq: ['$review.status', 'Rejected'] },
                          { $eq: ['$review.reviewOption', 'Rejected'] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'reject' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                dispatchedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$isDispatched', true] },
                          { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                biwAcceptCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Accepted'] }, 1, 0] }
                },
                biwRejectCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Rejected'] }, 1, 0] }
                },
                biwDefectCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Rejected', 'Reworked']] }, 1, 0] }
                },
                biwReviewedCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Accepted', 'Rejected', 'Reworked']] }, 1, 0] }
                },
                tvsAcceptCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Accepted'] }, { $eq: ['$review.reviewOption', 'Accepted'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsRejectCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Rejected'] }, { $eq: ['$review.reviewOption', 'Rejected'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReworkCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Rework', 'Reworked']] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReviewedCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }] },
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
                total30Count: {
                  $sum: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 1, 0] }
                },
                dispatched30Count: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$createdAt', thirtyDaysAgo] },
                          {
                            $or: [
                              { $eq: ['$isDispatched', true] },
                              { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                            ]
                          }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                defect30Count: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$createdAt', thirtyDaysAgo] },
                          {
                            $or: [
                              { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                              { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                              { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                              { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                              {
                                $anyElementTrue: {
                                  $map: {
                                    input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                    as: 'ans',
                                    in: {
                                      $regexMatch: {
                                        input: {
                                          $toLower: {
                                            $ifNull: [
                                              '$$ans.v.status',
                                              {
                                                $cond: [
                                                  { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                                  '$$ans.v',
                                                  ''
                                                ]
                                              }
                                            ]
                                          }
                                        },
                                        regex: 'rework|rejected|defect|fail|not ok'
                                      }
                                    }
                                  }
                                }
                              }
                            ]
                          }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                          {
                            $anyElementTrue: {
                              $map: {
                                input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                as: 'ans',
                                in: {
                                  $regexMatch: {
                                    input: {
                                      $toLower: {
                                        $ifNull: [
                                          '$$ans.v.status',
                                          {
                                            $cond: [
                                              { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                              '$$ans.v',
                                              ''
                                            ]
                                          }
                                        ]
                                      }
                                    },
                                    regex: 'rework|rejected|defect|fail|not ok'
                                  }
                                }
                              }
                            }
                          }
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
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Reworked'] },
                          { $in: ['$review.status', ['Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                reworkAcceptedCount: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework accept|rework complete' } },
                      1,
                      0
                    ]
                  }
                },
                rejectedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Rejected'] },
                          { $eq: ['$review.status', 'Rejected'] },
                          { $eq: ['$review.reviewOption', 'Rejected'] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'reject' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                biwAcceptCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Accepted'] }, 1, 0] }
                },
                biwRejectCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Rejected'] }, 1, 0] }
                },
                biwDefectCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Rejected', 'Reworked']] }, 1, 0] }
                },
                biwReviewedCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Accepted', 'Rejected', 'Reworked']] }, 1, 0] }
                },
                tvsAcceptCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Accepted'] }, { $eq: ['$review.reviewOption', 'Accepted'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsRejectCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Rejected'] }, { $eq: ['$review.reviewOption', 'Rejected'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReworkCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Rework', 'Reworked']] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReviewedCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }] },
                      1,
                      0
                    ]
                  }
                },
                dispatchedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$isDispatched', true] },
                          { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                        ]
                      },
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
                _id: {
                  inspector: { $trim: { input: { $ifNull: ['$submittedBy', 'Unknown Submitter'] } } },
                  formKey: '$questionId'
                },
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                          {
                            $anyElementTrue: {
                              $map: {
                                input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                as: 'ans',
                                in: {
                                  $regexMatch: {
                                    input: {
                                      $toLower: {
                                        $ifNull: [
                                          '$$ans.v.status',
                                          {
                                            $cond: [
                                              { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                              '$$ans.v',
                                              ''
                                            ]
                                          }
                                        ]
                                      }
                                    },
                                    regex: 'rework|rejected|defect|fail|not ok'
                                  }
                                }
                              }
                            }
                          }
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
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Reworked'] },
                          { $in: ['$review.status', ['Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                reworkAcceptedCount: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework accept|rework complete' } },
                      1,
                      0
                    ]
                  }
                },
                rejectedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Rejected'] },
                          { $eq: ['$review.status', 'Rejected'] },
                          { $eq: ['$review.reviewOption', 'Rejected'] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'reject' } }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                biwAcceptCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Accepted'] }, 1, 0] }
                },
                biwRejectCount: {
                  $sum: { $cond: [{ $eq: ['$biwReview.status', 'Rejected'] }, 1, 0] }
                },
                biwDefectCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Rejected', 'Reworked']] }, 1, 0] }
                },
                biwReviewedCount: {
                  $sum: { $cond: [{ $in: ['$biwReview.status', ['Accepted', 'Rejected', 'Reworked']] }, 1, 0] }
                },
                tvsAcceptCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Accepted'] }, { $eq: ['$review.reviewOption', 'Accepted'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsRejectCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $eq: ['$review.status', 'Rejected'] }, { $eq: ['$review.reviewOption', 'Rejected'] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReworkCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Rework', 'Reworked']] }] },
                      1,
                      0
                    ]
                  }
                },
                tvsReviewedCount: {
                  $sum: {
                    $cond: [
                      { $or: [{ $in: ['$review.status', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }, { $in: ['$review.reviewOption', ['Accepted', 'Rejected', 'Rework', 'Reworked']] }] },
                      1,
                      0
                    ]
                  }
                },
                dispatchedCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ['$isDispatched', true] },
                          { $and: [{ $ne: ['$dispatchedAt', null] }, { $gt: ['$dispatchedAt', ''] }] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                tenantId: { $first: '$tenantId' },
                createdBy: { $first: '$createdBy' }
              }
            }
          ],
          byDay: [
            {
              $group: {
                _id: {
                  date: {
                    $cond: [
                      { $eq: [{ $type: '$createdAt' }, 'date'] },
                      { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                      { $substrCP: [{ $ifNull: ['$createdAt', '1970-01-01'] }, 0, 10] }
                    ]
                  },
                  formKey: '$questionId'
                },
                totalChecked: { $sum: 1 },
                defectCount: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: ['$biwReview.status', ['Rejected', 'Reworked']] },
                          { $in: ['$review.status', ['Rejected', 'Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rejected', 'Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework|rejected|defect|fail' } },
                          {
                            $anyElementTrue: {
                              $map: {
                                input: { $objectToArray: { $ifNull: ['$answers', {}] } },
                                as: 'ans',
                                in: {
                                  $regexMatch: {
                                    input: {
                                      $toLower: {
                                        $ifNull: [
                                          '$$ans.v.status',
                                          {
                                            $cond: [
                                              { $eq: [{ $type: '$$ans.v' }, 'string'] },
                                              '$$ans.v',
                                              ''
                                            ]
                                          }
                                        ]
                                      }
                                    },
                                    regex: 'rework|rejected|defect|fail|not ok'
                                  }
                                }
                              }
                            }
                          }
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
                      {
                        $or: [
                          { $eq: ['$biwReview.status', 'Reworked'] },
                          { $in: ['$review.status', ['Rework', 'Reworked']] },
                          { $in: ['$review.reviewOption', ['Rework', 'Reworked']] },
                          { $regexMatch: { input: { $toLower: { $ifNull: ['$status', ''] } }, regex: 'rework' } }
                        ]
                      },
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
                chassisNumber: 1,
                answers: 1
              }
            }
          ],
          defectResponses: [
            {
              $match: {
                $or: [
                  { 'biwReview.status': { $in: ['Rejected', 'Reworked'] } },
                  { 'review.status': { $in: ['Rejected', 'Rework', 'Reworked'] } },
                  { 'review.reviewOption': { $in: ['Rejected', 'Rework', 'Reworked'] } },
                  { status: { $regex: 'rework|rejected|defect|fail', $options: 'i' } }
                ]
              }
            },
            { $limit: 300 },
            { $project: { _id: 1, submittedBy: 1, questionId: 1, answers: 1, biwReview: 1, review: 1, status: 1 } }
          ]
        }
      }
    ];

    const aggResult = await Response.aggregate(pipeline).option({ maxTimeMS: 90000, allowDiskUse: true });
    const agg = aggResult[0] || {};

    const summary = agg.summary?.[0] || { totalChecked: 0, defectCount: 0, rework1Count: 0 };
    const totalChecked = summary.totalChecked || 0;
    let totalDefects = summary.defectCount || 0;
    let totalAccepted = Math.max(0, totalChecked - totalDefects);
    const totalRework1 = summary.rework1Count || 0;
    let overallAcceptRate = totalChecked > 0 ? Math.round((totalAccepted / totalChecked) * 10000) / 100 : 0;
    let overallDefectRate = Math.max(0, Math.round((100 - overallAcceptRate) * 100) / 100);

    const reworkAcceptedCount = summary.reworkAcceptedCount || 0;
    const rejectedCount = summary.rejectedCount !== undefined ? summary.rejectedCount : Math.max(0, totalDefects - totalRework1);
    const directOkCount = Math.max(0, totalAccepted - reworkAcceptedCount);

    const totalDispatched = summary.dispatchedCount || 0;
    // Pending Dispatch: strictly for the last 30 days alone
    const isWiderThan30Days = !startDate || (startObj && startObj < thirtyDaysAgo);
    const approved30 = Math.max(0, (summary.total30Count || 0) - (summary.defect30Count || 0));
    const pendingDispatch = isWiderThan30Days && summary.total30Count !== undefined
      ? Math.max(0, approved30 - (summary.dispatched30Count || 0))
      : Math.max(0, (directOkCount + reworkAcceptedCount) - totalDispatched);
    const totalBiwReviewed = summary.biwReviewedCount || 0;
    const pendingBiw = Math.max(0, totalDispatched - totalBiwReviewed);

    summary.totalChecked = totalChecked;
    summary.totalAccepted = totalAccepted;
    summary.totalDefects = totalDefects;
    summary.totalRework1 = totalRework1;
    summary.totalDispatched = totalDispatched;
    summary.pendingDispatch = pendingDispatch;
    summary.totalBiwReviewed = totalBiwReviewed;
    summary.pendingBiw = pendingBiw;
    summary.reworkAcceptedCount = reworkAcceptedCount;
    summary.rejectedCount = rejectedCount;
    summary.directOkCount = directOkCount;
    summary.overallAcceptRate = overallAcceptRate;
    summary.overallDefectRate = overallDefectRate;
    summary.dispatchedRate = totalChecked > 0 ? Math.round((totalDispatched / totalChecked) * 10000) / 100 : 0;
    summary.biwReviewedRate = totalChecked > 0 ? Math.round((totalBiwReviewed / totalChecked) * 10000) / 100 : 0;

    // TVS Review counts
    let tvsReviewedCount = summary.tvsReviewedCount || 0;
    let tvsAcceptCount = summary.tvsAcceptCount || 0;
    let tvsRejectCount = summary.tvsRejectCount || 0;
    let tvsReworkCount = summary.tvsReworkCount || 0;

    // Fast-path: Only check separate Review collection if not already captured from responses
    if (tvsReviewedCount === 0) {
      try {
        const reviewFilter = {
          ...(req.user?.tenantId ? {
            $or: [
              { tenantId: req.user.tenantId.toString() },
              { tenantId: new mongoose.Types.ObjectId(req.user.tenantId) }
            ]
          } : {}),
          ...(startObj || endObj ? { createdAt: { ...(startObj ? { $gte: startObj } : {}), ...(endObj ? { $lte: endObj } : {}) } } : {})
        };
        const collReviews = await Review.aggregate([
          { $match: reviewFilter },
          { $group: { _id: '$reviewOption', count: { $sum: 1 } } }
        ]).option({ maxTimeMS: 5000 });
        if (collReviews && collReviews.length > 0) {
          let collAccept = 0, collReject = 0, collRework = 0;
          collReviews.forEach(r => {
            if (r._id === 'Accepted') collAccept += r.count;
            else if (r._id === 'Rejected') collReject += r.count;
            else if (r._id === 'Rework' || r._id === 'Reworked') collRework += r.count;
          });
          const collTotal = collAccept + collReject + collRework;
          if (collTotal > tvsReviewedCount) {
            tvsReviewedCount = collTotal;
            tvsAcceptCount = collAccept;
            tvsRejectCount = collReject;
            tvsReworkCount = collRework;
          }
        }
      } catch (e) {
        console.warn('[Quality Summary] Could not query Review collection:', e.message);
      }
    }

    summary.tvsReviewedCount = tvsReviewedCount;
    summary.tvsAcceptCount = tvsAcceptCount;
    summary.tvsRejectCount = tvsRejectCount;
    summary.tvsReworkCount = tvsReworkCount;
    summary.pendingTvsReview = Math.max(0, totalDispatched - tvsReviewedCount);

    // Defect breakdown extraction from responses (direct from aggregation facet)
    const defectTypeMap = {};
    const biwDefectTypeMap = {};
    const tvsDefectTypeMap = {};
    const inspectorDefectMap = {};
    const defectFormMap = {};
    const biwDefectFormMap = {};
    const tvsDefectFormMap = {};
    const inspectorDefectUnitCount = {};
    let totalDefectUnits = 0;

    try {
      const defectScanResponses = (agg.defectResponses && agg.defectResponses.length > 0)
        ? agg.defectResponses
        : [];

      defectScanResponses.forEach(dr => {
        const fTitle = formTitleMap[dr.questionId] || 'Selected Form';
        const rawName = (dr.submittedBy || 'Unknown Submitter').trim();
        if (!inspectorDefectMap[rawName]) inspectorDefectMap[rawName] = {};

        let hasDefect = false;

        // 1. Defect extraction from answers (Factory floor / General inspection)
        if (dr.answers && typeof dr.answers === 'object') {
          const answersObj = dr.answers instanceof Map ? Object.fromEntries(dr.answers) : dr.answers;
          for (const [key, val] of Object.entries(answersObj)) {
            if (!val || key === 'chassis_number' || key === 'chassis') continue;
            let isDef = false;
            if (typeof val === 'object' && val.status) {
              const st = String(val.status).trim().toLowerCase();
              if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(st)) isDef = true;
            } else if (typeof val === 'string') {
              const vLow = val.trim().toLowerCase();
              if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(vLow)) isDef = true;
            }

            if (isDef) {
              hasDefect = true;
              const qTitle = questionTitleMap[key] || key;
              defectTypeMap[qTitle] = (defectTypeMap[qTitle] || 0) + 1;
              inspectorDefectMap[rawName][qTitle] = (inspectorDefectMap[rawName][qTitle] || 0) + 1;
              if (!defectFormMap[qTitle]) defectFormMap[qTitle] = {};
              defectFormMap[qTitle][fTitle] = (defectFormMap[qTitle][fTitle] || 0) + 1;
            }
          }
        }

        // 2. Defect extraction from biwReview (Specifically for BIW Review tab)
        if (dr.biwReview) {
          const bStatus = String(dr.biwReview.status || '').toLowerCase();
          const isBiwDefect = bStatus.includes('reject') || bStatus.includes('rework');
          if (isBiwDefect) hasDefect = true;

          let biwFlaggedFound = false;
          if (Array.isArray(dr.biwReview.flaggedQuestions)) {
            dr.biwReview.flaggedQuestions.forEach(fq => {
              const fqTitle = (fq.questionText || fq.text || fq.title || questionTitleMap[fq.questionId] || fq.reason || '').trim();
              if (fqTitle && !['other', 'none', '-', 'ok', 'accepted'].includes(fqTitle.toLowerCase())) {
                biwDefectTypeMap[fqTitle] = (biwDefectTypeMap[fqTitle] || 0) + 1;
                if (!biwDefectFormMap[fqTitle]) biwDefectFormMap[fqTitle] = {};
                biwDefectFormMap[fqTitle][fTitle] = (biwDefectFormMap[fqTitle][fTitle] || 0) + 1;
                biwFlaggedFound = true;
              }
            });
          }
          if (dr.biwReview.reason && typeof dr.biwReview.reason === 'string') {
            const reasonTitle = dr.biwReview.reason.trim();
            if (reasonTitle && !['other', 'none', '-', 'ok', 'accepted'].includes(reasonTitle.toLowerCase())) {
              biwDefectTypeMap[reasonTitle] = (biwDefectTypeMap[reasonTitle] || 0) + 1;
              if (!biwDefectFormMap[reasonTitle]) biwDefectFormMap[reasonTitle] = {};
              biwDefectFormMap[reasonTitle][fTitle] = (biwDefectFormMap[reasonTitle][fTitle] || 0) + 1;
              biwFlaggedFound = true;
            }
          }
          // If BIW rejected/reworked without specific flagged question text, extract this response's defect answers
          if (isBiwDefect && !biwFlaggedFound && dr.answers && typeof dr.answers === 'object') {
            const answersObj = dr.answers instanceof Map ? Object.fromEntries(dr.answers) : dr.answers;
            for (const [key, val] of Object.entries(answersObj)) {
              if (!val || key === 'chassis_number' || key === 'chassis') continue;
              let isDef = false;
              if (typeof val === 'object' && val.status) {
                const st = String(val.status).trim().toLowerCase();
                if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(st)) isDef = true;
              } else if (typeof val === 'string') {
                const vLow = val.trim().toLowerCase();
                if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(vLow)) isDef = true;
              }
              if (isDef) {
                const qTitle = questionTitleMap[key] || key;
                biwDefectTypeMap[qTitle] = (biwDefectTypeMap[qTitle] || 0) + 1;
                if (!biwDefectFormMap[qTitle]) biwDefectFormMap[qTitle] = {};
                biwDefectFormMap[qTitle][fTitle] = (biwDefectFormMap[qTitle][fTitle] || 0) + 1;
              }
            }
          }
        }

        // 3. Defect extraction from TVS review (Specifically for TVS Review tab)
        if (dr.review) {
          const revStatus = String(dr.review.status || dr.review.reviewOption || '').toLowerCase();
          const isTvsDefect = revStatus.includes('reject') || revStatus.includes('rework');
          if (isTvsDefect) hasDefect = true;

          let tvsFlaggedFound = false;
          if (Array.isArray(dr.review.flaggedQuestions)) {
            dr.review.flaggedQuestions.forEach(fq => {
              const fqTitle = (fq.questionText || fq.text || fq.title || questionTitleMap[fq.questionId] || fq.reason || '').trim();
              if (fqTitle && !['other', 'none', '-', 'ok', 'accepted'].includes(fqTitle.toLowerCase())) {
                tvsDefectTypeMap[fqTitle] = (tvsDefectTypeMap[fqTitle] || 0) + 1;
                if (!tvsDefectFormMap[fqTitle]) tvsDefectFormMap[fqTitle] = {};
                tvsDefectFormMap[fqTitle][fTitle] = (tvsDefectFormMap[fqTitle][fTitle] || 0) + 1;
                tvsFlaggedFound = true;
              }
            });
          }
          const revReason = (dr.review.reason || dr.review.remark || '').trim();
          if (revReason && !['other', 'none', '-', 'ok', 'accepted', 'test', 'rework requested for flagged questions.'].includes(revReason.toLowerCase())) {
            tvsDefectTypeMap[revReason] = (tvsDefectTypeMap[revReason] || 0) + 1;
            if (!tvsDefectFormMap[revReason]) tvsDefectFormMap[revReason] = {};
            tvsDefectFormMap[revReason][fTitle] = (tvsDefectFormMap[revReason][fTitle] || 0) + 1;
            tvsFlaggedFound = true;
          }
          if (isTvsDefect && !tvsFlaggedFound && dr.answers && typeof dr.answers === 'object') {
            const answersObj = dr.answers instanceof Map ? Object.fromEntries(dr.answers) : dr.answers;
            for (const [key, val] of Object.entries(answersObj)) {
              if (!val || key === 'chassis_number' || key === 'chassis') continue;
              let isDef = false;
              if (typeof val === 'object' && val.status) {
                const st = String(val.status).trim().toLowerCase();
                if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(st)) isDef = true;
              } else if (typeof val === 'string') {
                const vLow = val.trim().toLowerCase();
                if (['rework', 'reworked', 'defect', 'rejected', 'no', 'not ok', 'fail'].includes(vLow)) isDef = true;
              }
              if (isDef) {
                const qTitle = questionTitleMap[key] || key;
                tvsDefectTypeMap[qTitle] = (tvsDefectTypeMap[qTitle] || 0) + 1;
                if (!tvsDefectFormMap[qTitle]) tvsDefectFormMap[qTitle] = {};
                tvsDefectFormMap[qTitle][fTitle] = (tvsDefectFormMap[qTitle][fTitle] || 0) + 1;
              }
            }
          }
        }

        if (hasDefect) {
          totalDefectUnits++;
          inspectorDefectUnitCount[rawName] = (inspectorDefectUnitCount[rawName] || 0) + 1;
        }
      });

      // Extract TVS defects from Review collection for reviews stored externally
      try {
        const reviewFilter = {
          $or: [
            { reviewOption: { $in: ['Rejected', 'Rework'] } },
            { status: { $in: ['Rejected', 'Rework'] } },
            { 'flaggedQuestions.0': { $exists: true } }
          ],
          ...(startObj || endObj ? { createdAt: { ...(startObj ? { $gte: startObj } : {}), ...(endObj ? { $lte: endObj } : {}) } } : { createdAt: { $gte: thirtyDaysAgo } })
        };
        const collReviews = await Review.find(reviewFilter).select('flaggedQuestions reason remark reviewOption status').lean().limit(100);
        collReviews.forEach(rev => {
          if (Array.isArray(rev.flaggedQuestions)) {
            rev.flaggedQuestions.forEach(fq => {
              const fqTitle = (fq.questionText || fq.text || fq.title || questionTitleMap[fq.questionId] || fq.reason || '').trim();
              if (fqTitle && !['other', 'none', '-', 'ok', 'accepted'].includes(fqTitle.toLowerCase())) {
                tvsDefectTypeMap[fqTitle] = (tvsDefectTypeMap[fqTitle] || 0) + 1;
              }
            });
          }
          const revReason = (rev.reason || rev.remark || '').trim();
          if (revReason && !['other', 'none', '-', 'ok', 'accepted', 'test', 'rework requested for flagged questions.'].includes(revReason.toLowerCase())) {
            tvsDefectTypeMap[revReason] = (tvsDefectTypeMap[revReason] || 0) + 1;
          }
        });
      } catch (collErr) {
        console.warn('[Quality Summary] Coll reviews defect extraction note:', collErr.message);
      }
    } catch (err) {
      console.warn('[Quality Summary] Defect extraction error:', err.message);
    }

    const computedDefectTotal = Object.values(defectTypeMap).reduce((a, b) => a + b, 0);
    if (totalDefectUnits > totalDefects || totalDefects === 0) {
      totalDefects = totalDefectUnits > 0 ? totalDefectUnits : computedDefectTotal;
      totalAccepted = Math.max(0, totalChecked - totalDefects);
      overallAcceptRate = totalChecked > 0 ? Math.round((totalAccepted / totalChecked) * 10000) / 100 : 0;
      overallDefectRate = Math.max(0, Math.round((100 - overallAcceptRate) * 100) / 100);
      summary.defectCount = totalDefects;
      summary.totalAccepted = totalAccepted;
      summary.overallAcceptRate = overallAcceptRate;
      summary.overallDefectRate = overallDefectRate;
    }

    const defectBreakdown = Object.entries(defectTypeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        forms: defectFormMap[name] || {}
      }));

    const biwDefectBreakdown = Object.entries(biwDefectTypeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        forms: biwDefectFormMap[name] || {}
      }));

    const tvsDefectBreakdown = Object.entries(tvsDefectTypeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        forms: tvsDefectFormMap[name] || {}
      }));

    // Per-Form Summary List - Combine metrics for both UUID and ObjectId keys of each form
    const formMetricMap = {};
    (agg.byForm || []).forEach(item => {
      formMetricMap[item._id] = item;
    });

    const formsSummary = accessibleForms.map(f => {
      const keys = [f.id, f._id ? f._id.toString() : ''].filter(Boolean);
      let tChecked = 0;
      let dCount = 0;
      let r1Count = 0;
      let rwAccepted = 0;
      let rejCount = 0;
      let bAccept = 0;
      let bReject = 0;
      let bDefect = 0;
      let bReviewed = 0;
      let dDispatched = 0;
      let t30 = 0;
      let disp30 = 0;
      let def30 = 0;
      let tvsAccept = 0;
      let tvsReject = 0;
      let tvsRework = 0;
      let tvsReviewed = 0;
      const inspectorSet = new Set();
      let lastDate = null;

      keys.forEach(k => {
        const m = formMetricMap[k];
        if (m) {
          tChecked += m.totalChecked || 0;
          dCount += m.defectCount || 0;
          r1Count += m.rework1Count || 0;
          rwAccepted += m.reworkAcceptedCount || 0;
          rejCount += m.rejectedCount || 0;
          bAccept += m.biwAcceptCount || 0;
          bReject += m.biwRejectCount || 0;
          bDefect += m.biwDefectCount || 0;
          bReviewed += m.biwReviewedCount || 0;
          dDispatched += m.dispatchedCount || 0;
          t30 += m.total30Count || 0;
          disp30 += m.dispatched30Count || 0;
          def30 += m.defect30Count || 0;
          tvsAccept += m.tvsAcceptCount || 0;
          tvsReject += m.tvsRejectCount || 0;
          tvsRework += m.tvsReworkCount || 0;
          tvsReviewed += m.tvsReviewedCount || 0;
          if (Array.isArray(m.inspectors)) {
            m.inspectors.forEach(insp => { if (insp) inspectorSet.add(insp); });
          }
          if (m.lastInspectionDate) {
            if (!lastDate || new Date(m.lastInspectionDate) > new Date(lastDate)) {
              lastDate = m.lastInspectionDate;
            }
          }
        }
      });

      if (dCount === 0) {
        const formDefectSum = Object.values(defectFormMap).reduce((sum, fMap) => sum + (fMap[f.title] || 0), 0);
        if (formDefectSum > 0) {
          dCount = formDefectSum;
          r1Count = formDefectSum;
        }
      }

      const aCount = Math.max(0, tChecked - dCount);
      const aRate = tChecked > 0 ? Math.round((aCount / tChecked) * 10000) / 100 : 0;
      const dRate = Math.max(0, Math.round((100 - aRate) * 100) / 100);

      // Reconcile defects, rework and rejected counts strictly
      let finalRej = rejCount;
      let finalR1 = r1Count;
      if (dCount > 0) {
        if (finalRej + finalR1 !== dCount) {
          if (finalRej > 0 && finalR1 === 0) {
            finalR1 = Math.max(0, dCount - finalRej);
          } else if (finalR1 > 0 && finalRej === 0) {
            finalRej = Math.max(0, dCount - finalR1);
          } else if (finalRej === 0 && finalR1 === 0) {
            finalR1 = dCount;
          }
        }
      }

      const biwTotal = bReviewed > 0 ? bReviewed : (bAccept + bDefect);
      const biwRate = biwTotal > 0 ? Math.round((bAccept / biwTotal) * 10000) / 100 : (tChecked > 0 ? 100 : 0);
      const directOk = Math.max(0, aCount - rwAccepted);

      return {
        id: f.id || f._id.toString(),
        _id: f._id.toString(),
        title: f.title,
        isChildForm: Boolean(f.isChildForm || f.parentFormId),
        parentFormId: f.parentFormId ? f.parentFormId.toString() : null,
        parentFormTitle: f.parentFormTitle || null,
        childForms: f.childForms || [],
        totalChecked: tChecked,
        acceptCount: aCount,
        defectCount: dCount,
        rework1Count: finalR1,
        reworkAcceptedCount: rwAccepted,
        rejectedCount: finalRej,
        directOkCount: directOk,
        dispatchedCount: dDispatched,
        pendingDispatchCount: isWiderThan30Days && t30 > 0
          ? Math.max(0, (t30 - def30) - disp30)
          : Math.max(0, (directOk + rwAccepted) - dDispatched),
        biwAcceptCount: bAccept,
        biwRejectCount: bReject,
        biwDefectCount: bDefect,
        biwReviewedCount: biwTotal,
        pendingBiwCount: Math.max(0, dDispatched - biwTotal),
        tvsAcceptCount: tvsAccept,
        tvsRejectCount: tvsReject,
        tvsReworkCount: tvsRework,
        tvsReviewedCount: tvsReviewed,
        pendingTvsCount: Math.max(0, dDispatched - tvsReviewed),
        biwAcceptRate: biwRate,
        acceptRate: aRate,
        defectRate: dRate,
        totalInspectors: inspectorSet.size,
        inspectors: Array.from(inspectorSet),
        lastInspectionDate: lastDate ? new Date(lastDate).toISOString().split('T')[0] : null,
        masterTotal: (masterFormCounts[f.id] || 0) + (masterFormCounts[f._id?.toString()] || 0)
      };
    }).sort((a, b) => b.totalChecked - a.totalChecked);

    const isDateFiltered = Boolean(startDate || endDate);
    const formOptions = accessibleForms.map(f => {
      const idStr = f.id ? f.id.toString() : '';
      const mongoIdStr = f._id ? f._id.toString() : '';
      const mCount = (masterFormCounts[idStr] || 0) + (masterFormCounts[mongoIdStr] || 0);
      const keys = [idStr, mongoIdStr].filter(Boolean);
      let activeCount = 0;
      keys.forEach(k => {
        const m = formMetricMap[k];
        if (m) activeCount += m.totalChecked || 0;
      });
      return {
        id: idStr || mongoIdStr,
        _id: mongoIdStr,
        title: f.title,
        isChildForm: Boolean(f.isChildForm || f.parentFormId),
        parentFormId: f.parentFormId ? f.parentFormId.toString() : null,
        parentFormTitle: f.parentFormTitle || null,
        totalChecked: isDateFiltered ? activeCount : mCount,
        activeChecked: activeCount,
        masterTotal: mCount
      };
    }).sort((a, b) => (b.totalChecked - a.totalChecked) || ((b.masterTotal || 0) - (a.masterTotal || 0)));

    // Inspector performance ratings
    let exemplaryCount = 0;
    let exceededCount = 0;
    let metCount = 0;
    let partiallyMetCount = 0;

    // Build tenant lookup maps to attach tenant names to inspectors
    const allTenantsList = await Tenant.find({}).select('_id name companyName').lean();
    const tenantMap = {};
    allTenantsList.forEach(t => {
      tenantMap[t._id.toString()] = t.companyName || t.name || '';
    });

    const allUsersList = await User.find({}).select('firstName lastName username email tenantId').populate('tenantId', 'name companyName').lean();
    const userTenantMap = {};
    allUsersList.forEach(u => {
      const tName = u.tenantId?.companyName || u.tenantId?.name || (u.tenantId ? tenantMap[u.tenantId.toString()] : '') || '';
      if (tName) {
        const full = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase();
        if (full) userTenantMap[full] = tName;
        if (u.username) userTenantMap[u.username.trim().toLowerCase()] = tName;
        if (u.email) userTenantMap[u.email.trim().toLowerCase()] = tName;
        if (u.firstName) userTenantMap[u.firstName.trim().toLowerCase()] = tName;
      }
    });

    // Aggregate inspector records by name and retain form-wise metrics
    const inspectorAggMap = {};
    (agg.byInspector || []).forEach(item => {
      const inspName = typeof item._id === 'object' ? (item._id.inspector || 'Unknown Submitter') : (item._id || 'Unknown Submitter');
      const formKey = typeof item._id === 'object' ? item._id.formKey : null;
      const fTitle = formTitleMap[formKey] || formKey || 'Selected Form';
      const cleanInspLower = inspName.trim().toLowerCase();
      const resolvedTenant = userTenantMap[cleanInspLower] || (item.tenantId ? tenantMap[item.tenantId.toString()] : '') || '';

      if (!inspectorAggMap[inspName]) {
        inspectorAggMap[inspName] = {
          name: inspName,
          tenantName: resolvedTenant,
          totalChecked: 0,
          defectCount: 0,
          rework1Count: 0,
          reworkAcceptedCount: 0,
          rejectedCount: 0,
          biwAcceptCount: 0,
          biwRejectCount: 0,
          biwDefectCount: 0,
          biwReviewedCount: 0,
          tvsAcceptCount: 0,
          tvsRejectCount: 0,
          tvsReworkCount: 0,
          tvsReviewedCount: 0,
          dispatchedCount: 0,
          forms: {}
        };
      } else if (!inspectorAggMap[inspName].tenantName && resolvedTenant) {
        inspectorAggMap[inspName].tenantName = resolvedTenant;
      }

      inspectorAggMap[inspName].totalChecked += item.totalChecked || 0;
      inspectorAggMap[inspName].defectCount += item.defectCount || 0;
      inspectorAggMap[inspName].rework1Count += item.rework1Count || 0;
      inspectorAggMap[inspName].reworkAcceptedCount += item.reworkAcceptedCount || 0;
      inspectorAggMap[inspName].rejectedCount += item.rejectedCount || 0;
      inspectorAggMap[inspName].biwAcceptCount += item.biwAcceptCount || 0;
      inspectorAggMap[inspName].biwRejectCount += item.biwRejectCount || 0;
      inspectorAggMap[inspName].biwDefectCount += item.biwDefectCount || 0;
      inspectorAggMap[inspName].biwReviewedCount += item.biwReviewedCount || 0;
      inspectorAggMap[inspName].tvsAcceptCount += item.tvsAcceptCount || 0;
      inspectorAggMap[inspName].tvsRejectCount += item.tvsRejectCount || 0;
      inspectorAggMap[inspName].tvsReworkCount += item.tvsReworkCount || 0;
      inspectorAggMap[inspName].tvsReviewedCount += item.tvsReviewedCount || 0;
      inspectorAggMap[inspName].dispatchedCount += item.dispatchedCount || 0;

      if (formKey) {
        if (!inspectorAggMap[inspName].forms[fTitle]) {
          inspectorAggMap[inspName].forms[fTitle] = { checked: 0, defects: 0, acceptCount: 0 };
        }
        inspectorAggMap[inspName].forms[fTitle].checked += item.totalChecked || 0;
        inspectorAggMap[inspName].forms[fTitle].defects += item.defectCount || 0;
        inspectorAggMap[inspName].forms[fTitle].acceptCount += Math.max(0, (item.totalChecked || 0) - (item.defectCount || 0));
      }
    });

    // Reconcile inspector defect counts with extracted defect units from answers / biwReview
    Object.keys(inspectorAggMap).forEach(inspName => {
      const insp = inspectorAggMap[inspName];
      const extractedDefects = inspectorDefectUnitCount[inspName]
        ?? (inspectorDefectMap[inspName] ? Object.values(inspectorDefectMap[inspName]).reduce((a, b) => a + b, 0) : 0);
      if (extractedDefects > 0 && (insp.defectCount === 0 || extractedDefects > insp.defectCount)) {
        insp.defectCount = Math.min(insp.totalChecked, extractedDefects);
        insp.rework1Count = Math.max(insp.rework1Count, insp.defectCount);
      }
    });

    const inspectorList = Object.values(inspectorAggMap).map(insp => {
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

      const biwTotal = insp.biwReviewedCount || (insp.biwAcceptCount + insp.biwDefectCount);
      const biwAcceptRate = biwTotal > 0 ? Math.round((insp.biwAcceptCount / biwTotal) * 100) : 0;
      const biwDefectRate = Math.max(0, 100 - biwAcceptRate);

      const tvsDefectTotal = (insp.tvsRejectCount || 0) + (insp.tvsReworkCount || 0);
      const tvsTotal = insp.tvsReviewedCount || (insp.tvsAcceptCount + tvsDefectTotal);
      const tvsAcceptRate = tvsTotal > 0 ? Math.round((insp.tvsAcceptCount / tvsTotal) * 100) : 0;
      const tvsDefectRate = Math.max(0, 100 - tvsAcceptRate);

      const topDefects = Object.entries(inspectorDefectMap[insp.name] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));

      return {
        name: insp.name,
        tenantName: insp.tenantName || '',
        totalChecked: tChecked,
        totalSubmitted: tChecked,
        dispatched: insp.dispatchedCount || 0,
        dispatchedCount: insp.dispatchedCount || 0,
        totalReviewed: biwTotal,
        accepted: insp.biwAcceptCount || 0,
        rejected: insp.biwRejectCount || 0,
        rework: insp.biwDefectCount || 0,
        acceptCount: aCount,
        defectCount: dCount,
        rework1Count: insp.rework1Count,
        reworkAcceptedCount: insp.reworkAcceptedCount,
        biwAcceptCount: insp.biwAcceptCount,
        biwRejectCount: insp.biwRejectCount,
        biwDefectCount: insp.biwDefectCount,
        acceptRate,
        defectRate,
        performanceStatus,
        tier,
        arrow,
        biwAcceptRate,
        biwDefectRate,
        tvsAcceptCount: insp.tvsAcceptCount || 0,
        tvsRejectCount: insp.tvsRejectCount || 0,
        tvsReworkCount: insp.tvsReworkCount || 0,
        tvsDefectCount: tvsDefectTotal,
        tvsReviewedCount: tvsTotal,
        tvsAcceptRate,
        tvsDefectRate,
        performanceScore: biwTotal > 0 ? Math.round((insp.biwAcceptCount / biwTotal) * 100) : acceptRate,
        topDefects,
        forms: insp.forms
      };
    }).sort((a, b) => b.totalChecked - a.totalChecked);

    // Daily trends array with form-wise numbers
    const dayMap = {};
    (agg.byDay || []).forEach(d => {
      const dateStr = d._id?.date || d._id;
      if (!dateStr || dateStr === '1970-01-01') return;
      if (!dayMap[dateStr]) {
        dayMap[dateStr] = {
          date: dateStr,
          totalChecked: 0,
          defectCount: 0,
          reworkCount: 0,
          forms: {}
        };
      }
      dayMap[dateStr].totalChecked += d.totalChecked || 0;
      dayMap[dateStr].defectCount += d.defectCount || 0;
      dayMap[dateStr].reworkCount += d.reworkCount || 0;

      const fKey = d._id?.formKey;
      if (fKey) {
        const fTitle = formTitleMap[fKey] || fKey;
        if (!dayMap[dateStr].forms[fTitle]) {
          dayMap[dateStr].forms[fTitle] = { checked: 0, defects: 0 };
        }
        dayMap[dateStr].forms[fTitle].checked += d.totalChecked || 0;
        dayMap[dateStr].forms[fTitle].defects += d.defectCount || 0;
      }
    });

    const dailyTrends = Object.values(dayMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => {
        const aCount = Math.max(0, d.totalChecked - d.defectCount);
        return {
          date: d.date,
          totalChecked: d.totalChecked,
          acceptCount: aCount,
          defectCount: d.defectCount,
          reworkCount: d.reworkCount,
          passRate: d.totalChecked > 0 ? Math.round((aCount / d.totalChecked) * 10000) / 100 : 0,
          forms: d.forms
        };
      });

    const KNOWN_STATIC_TAGS = new Set(['TVS', 'SAFTY', 'SAIFY', 'SRIDEVI', 'EXCEL IMPORT', 'N/A', '-', 'DEFAULT', 'UNKNOWN', 'NONE']);

    const extractUniqueChassis = (r) => {
      const fId = (r.formId || r.questionId)?.toString();
      const chassisMeta = (fId && formChassisQuestionMap[fId]) || {};
      const targetQId = chassisMeta.primaryChassisQId;
      const ans = r.answers || {};

      // 1. Check designated chassis/identification question if present
      if (targetQId && ans[targetQId] !== undefined && ans[targetQId] !== null) {
        const val = ans[targetQId];
        if (typeof val === 'string' && val.trim()) return val.trim();
        if (typeof val === 'number') return String(val);
        if (typeof val === 'object') {
          const v = val.chassisNumber || val.value || val.id || val.v;
          if (v && typeof v !== 'object') return String(v).trim();
        }
      }

      // 2. Check any other answer key that might be an identification/chassis question
      for (const [key, val] of Object.entries(ans)) {
        if (!val) continue;
        const meta = questionMetaMap[key];
        const qTitle = (meta?.text || '').toLowerCase();
        if (
          qTitle.includes('identification') ||
          qTitle.includes('id number') ||
          qTitle.includes('id no') ||
          qTitle.includes('chassis') ||
          qTitle.includes('vin') ||
          qTitle.includes('serial')
        ) {
          if (typeof val === 'string' && val.trim() && val !== 'Accepted' && val !== 'Rejected' && val !== 'Reworked') {
            return val.trim();
          }
          if (typeof val === 'number') return String(val);
          if (typeof val === 'object') {
            const v = val.chassisNumber || val.value || val.id;
            if (v && typeof v !== 'object' && String(v).trim()) return String(v).trim();
          }
        }
      }

      // 3. Scan for any answer that looks like a unique unit code (not a status like 'Accepted'/'Rejected'/'Direct Ok')
      for (const [key, val] of Object.entries(ans)) {
        if (key === 'chassis_number' || key === 'chassis') continue;
        if (typeof val === 'string') {
          const s = val.trim();
          const low = s.toLowerCase();
          if (
            s.length > 0 &&
            s.length < 50 &&
            !['accepted', 'rejected', 'reworked', 'pending', 'direct ok', 'rework 1', 'rework 2', 'ok', 'not ok', 'pass', 'fail', 'true', 'false', 'none', 'n/a', '-'].includes(low) &&
            !KNOWN_STATIC_TAGS.has(s.toUpperCase()) &&
            !s.startsWith('{') &&
            !s.startsWith('http')
          ) {
            return s;
          }
        } else if (typeof val === 'number') {
          return String(val);
        }
      }

      // 4. If root r.chassisNumber exists and is NOT a known static vendor tag, use it
      if (r.chassisNumber && !KNOWN_STATIC_TAGS.has(String(r.chassisNumber).toUpperCase().trim())) {
        return String(r.chassisNumber).trim();
      }

      // 5. Fallback: root r.chassisNumber
      if (r.chassisNumber && r.chassisNumber !== 'none' && r.chassisNumber !== 'N/A' && r.chassisNumber !== '-') {
        return String(r.chassisNumber);
      }

      return 'N/A';
    };

    // Recent raw responses for the Excel-like grid
    const rawResponsesList = (agg.recentResponses || []).map(r => {
      const fTitle = formTitleMap[r.questionId] || formTitleMap[r.formId] || 'Unknown Form';
      const rawSt = (r.status || '').trim();

      const respDefects = [];
      if (r.answers && typeof r.answers === 'object') {
        const aObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers;
        for (const [key, val] of Object.entries(aObj)) {
          if (!val || key === 'chassis_number' || key === 'chassis') continue;
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
            respDefects.push(qTitle);
          }
        }
      }

      let dynamicStatus = rawSt;
      if (!dynamicStatus || dynamicStatus === 'pending') {
        dynamicStatus = respDefects.length > 0 ? 'Rework 1' : 'Direct Ok';
      } else if (dynamicStatus !== 'Accepted' && dynamicStatus !== 'Direct Ok' && dynamicStatus !== 'Rework Accepted') {
        dynamicStatus = dynamicStatus.startsWith('Rework') || dynamicStatus === 'Rejected' ? dynamicStatus : (respDefects.length > 0 ? 'Rework 1' : 'Direct Ok');
      }

      const uniqueChassis = extractUniqueChassis(r);
      const rootChassis = r.chassisNumber && r.chassisNumber !== 'none' && r.chassisNumber !== 'N/A' && r.chassisNumber !== '-' ? String(r.chassisNumber).trim() : '';
      const chassisVin = (rootChassis && rootChassis.toLowerCase() !== uniqueChassis.toLowerCase()) ? rootChassis : '-';

      const rawDate = r.createdAt ? new Date(r.createdAt) : new Date();
      const safeDate = rawDate.getTime() > Date.now() ? (r.submissionMetadata?.submittedAt ? new Date(r.submissionMetadata.submittedAt) : new Date()) : rawDate;
      const dateIso = !isNaN(safeDate.getTime()) ? safeDate.toISOString() : new Date().toISOString();

      return {
        id: r._id.toString(),
        chassisNumber: uniqueChassis,
        chassisVin: chassisVin,
        partDescription: chassisVin !== '-' ? chassisVin : '-',
        submittedBy: (r.submittedBy || 'Unknown Submitter').trim(),
        date: dateIso,
        createdAt: dateIso,
        status: dynamicStatus,
        biwReviewStatus: r.biwReview?.status || (dynamicStatus === 'Direct Ok' || dynamicStatus === 'Accepted' ? 'Accepted' : 'Pending'),
        formId: (r.formId || r.questionId)?.toString() || '',
        formTitle: fTitle,
        isDispatched: Boolean(r.isDispatched),
        answers: r.answers || {},
        defects: respDefects
      };
    });

    const payload = {
      success: true,
      data: {
        summary: {
          totalChecked,
          masterTotalChecked: accessibleForms.reduce((sum, f) => {
            const idStr = f.id ? f.id.toString() : '';
            const mongoIdStr = f._id ? f._id.toString() : '';
            return sum + (masterFormCounts[idStr] || 0) + (masterFormCounts[mongoIdStr] || 0);
          }, 0),
          totalAccepted,
          totalDefects,
          totalRework1,
          reworkAcceptedCount,
          rejectedCount,
          directOkCount,
          totalDispatched,
          pendingDispatch,
          totalBiwReviewed,
          pendingBiw,
          tvsReviewedCount: summary.tvsReviewedCount || 0,
          tvsAcceptCount: summary.tvsAcceptCount || 0,
          tvsRejectCount: summary.tvsRejectCount || 0,
          tvsReworkCount: summary.tvsReworkCount || 0,
          pendingTvsReview: summary.pendingTvsReview !== undefined ? summary.pendingTvsReview : Math.max(0, totalDispatched - (summary.tvsReviewedCount || 0)),
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
        biwDefectBreakdown,
        tvsDefectBreakdown,
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