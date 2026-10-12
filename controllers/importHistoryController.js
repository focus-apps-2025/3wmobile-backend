import mongoose from 'mongoose';
import BulkImportHistory from '../models/BulkImportHistory.js';
import Form from '../models/Form.js';
import User from '../models/User.js';
import Response from '../models/Response.js';

/**
 * Sync legacy Excel imports from Response collection into BulkImportHistory once
 * so existing historical data shows up immediately on the timeline.
 */
let isLegacySynced = false;
export const syncLegacyExcelImports = async (tenantId = null) => {
  if (isLegacySynced) return;
  try {
    const existingCount = await BulkImportHistory.countDocuments({ actionType: 'BULK_RESPONSE_IMPORT' });
    if (existingCount > 0) {
      isLegacySynced = true;
      return;
    }

    console.log('[IMPORT HISTORY] Syncing historical Excel imports into BulkImportHistory...');

    // Group legacy Excel Import responses by formId, createdBy and hour of creation
    const groups = await Response.aggregate([
      { $match: { submittedBy: 'Excel Import' } },
      {
        $group: {
          _id: {
            formId: "$questionId",
            createdBy: "$createdBy",
            tenantId: "$tenantId",
            timeGroup: {
              $dateToString: { format: "%Y-%m-%d %H:%M", date: "$createdAt" }
            }
          },
          count: { $sum: 1 },
          firstCreatedAt: { $min: "$createdAt" },
          sampleIds: { $push: "$id" },
          sampleAnswers: { $push: "$answers" }
        }
      },
      { $sort: { firstCreatedAt: -1 } }
    ]);

    if (groups.length === 0) {
      isLegacySynced = true;
      return;
    }

    const formsCache = new Map();
    const usersCache = new Map();

    const historyDocs = [];

    for (const grp of groups) {
      const formId = grp._id.formId;
      const createdById = grp._id.createdBy;
      let targetTenantId = grp._id.tenantId;

      // Get Form Title
      let formTitle = 'Imported Form';
      if (formId) {
        if (!formsCache.has(formId)) {
          const form = await Form.findOne({
            $or: [
              { id: formId },
              { _id: mongoose.Types.ObjectId.isValid(formId) ? new mongoose.Types.ObjectId(formId) : null }
            ].filter(Boolean)
          }).select('title tenantId').lean();
          formsCache.set(formId, form);
        }
        const cachedForm = formsCache.get(formId);
        if (cachedForm) {
          formTitle = cachedForm.title || formTitle;
          if (!targetTenantId) targetTenantId = cachedForm.tenantId;
        }
      }

      // Get User info
      let userName = 'System Admin';
      let userEmail = '';
      let userRole = 'admin';
      if (createdById) {
        const uIdStr = createdById.toString();
        if (!usersCache.has(uIdStr)) {
          const u = await User.findById(createdById).select('name username email role tenantId').lean();
          usersCache.set(uIdStr, u);
        }
        const cachedUser = usersCache.get(uIdStr);
        if (cachedUser) {
          userName = cachedUser.username || cachedUser.name || cachedUser.email || 'Admin';
          userEmail = cachedUser.email || '';
          userRole = cachedUser.role || 'admin';
          if (!targetTenantId) targetTenantId = cachedUser.tenantId;
        }
      }

      // Extract sample chassis numbers from answers
      const chassisSet = new Set();
      if (Array.isArray(grp.sampleAnswers)) {
        for (const ans of grp.sampleAnswers) {
          if (!ans) continue;
          const ansObj = ans instanceof Map ? Object.fromEntries(ans) : ans;
          if (typeof ansObj === 'object') {
            for (const [k, v] of Object.entries(ansObj)) {
              if (
                typeof v === 'string' &&
                v.trim() &&
                (k.toLowerCase().includes('chassis') || k.toLowerCase().includes('vin') || k.toLowerCase().includes('id number') || k === 'chassis_number')
              ) {
                chassisSet.add(v.trim());
                if (chassisSet.size >= 10) break;
              }
            }
          }
          if (chassisSet.size >= 10) break;
        }
      }

      historyDocs.push({
        tenantId: targetTenantId || new mongoose.Types.ObjectId('6a4600843f66fc9cd8e75074'),
        userId: createdById || null,
        userName,
        userEmail,
        userRole,
        actionType: 'BULK_RESPONSE_IMPORT',
        actionTitle: 'Excel Bulk Response Import',
        formId: formId || '',
        formTitle,
        batchId: `batch-legacy-${new Date(grp.firstCreatedAt).getTime()}`,
        fileName: 'Excel_Responses_Import.xlsx',
        templateType: 'Main Form',
        dataCount: {
          total: grp.count,
          success: grp.count,
          failed: 0
        },
        details: {
          chassisNumbers: Array.from(chassisSet),
          submitters: ['Excel Import'],
          questionsCount: 0,
          errors: [],
          notes: `Historical import of ${grp.count} responses`
        },
        status: 'success',
        createdAt: grp.firstCreatedAt || new Date()
      });
    }

    if (historyDocs.length > 0) {
      await BulkImportHistory.insertMany(historyDocs);
      console.log(`[IMPORT HISTORY] Synced ${historyDocs.length} historical import batches!`);
    }

    isLegacySynced = true;
  } catch (err) {
    console.error('[IMPORT HISTORY] Error syncing legacy imports:', err);
  }
};

/**
 * Record a new import / edit event in BulkImportHistory
 */
export const recordImportHistory = async (eventData) => {
  try {
    const historyEntry = new BulkImportHistory({
      tenantId: eventData.tenantId,
      userId: eventData.userId,
      userName: eventData.userName || 'System',
      userEmail: eventData.userEmail || '',
      userRole: eventData.userRole || 'admin',
      actionType: eventData.actionType || 'BULK_RESPONSE_IMPORT',
      actionTitle: eventData.actionTitle || 'Bulk Response Import',
      formId: eventData.formId || '',
      formTitle: eventData.formTitle || 'Untitled Form',
      batchId: eventData.batchId || `batch-${Date.now()}`,
      fileName: eventData.fileName || '',
      templateType: eventData.templateType || 'Main Form',
      dataCount: {
        total: eventData.dataCount?.total ?? 0,
        success: eventData.dataCount?.success ?? 0,
        failed: eventData.dataCount?.failed ?? 0
      },
      details: {
        chassisNumbers: eventData.details?.chassisNumbers || [],
        submitters: eventData.details?.submitters || [],
        questionsCount: eventData.details?.questionsCount || 0,
        sampleRecords: eventData.details?.sampleRecords || [],
        errors: eventData.details?.errors || [],
        notes: eventData.details?.notes || ''
      },
      status: eventData.status || 'success',
      createdAt: eventData.createdAt || new Date()
    });

    await historyEntry.save();
    return historyEntry;
  } catch (err) {
    console.error('[IMPORT HISTORY] Failed to record history entry:', err);
    return null;
  }
};

/**
 * GET /api/import-history
 * Fetch timeline-sorted history with optional filters (formId, actionType, search)
 */
export const getImportHistory = async (req, res) => {
  try {
    const { formId, actionType, search, page = 1, limit = 50 } = req.query;

    // Trigger legacy sync in the background so it never blocks the user request
    setImmediate(() => {
      syncLegacyExcelImports(req.user?.tenantId).catch(err => {
        console.warn('[IMPORT HISTORY] Background legacy sync error:', err.message);
      });
    });

    const query = {};
    const andConditions = [];

    // Tenant isolation: Superadmin and Admin can view all; others see own tenant + shared forms + own uploads
    if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
      const tenantIdStr = req.user?.tenantId ? req.user.tenantId.toString() : null;
      const tenantIdObj = mongoose.Types.ObjectId.isValid(tenantIdStr)
        ? new mongoose.Types.ObjectId(tenantIdStr)
        : null;
      const tenantValues = [tenantIdStr, tenantIdObj].filter(Boolean);
      const tenantConditions = [];

      if (tenantValues.length > 0) {
        tenantConditions.push({ tenantId: { $in: tenantValues } });
      }

      // Also allow history for forms shared with or accessible to this tenant
      if (tenantIdStr) {
        const accessibleForms = await Form.find({
          $or: [
            { isGlobal: true },
            { tenantId: { $in: tenantValues } },
            { sharedWithTenants: { $in: tenantValues } },
            { "chassisTenantAssignments.assignedTenants": tenantIdStr }
          ]
        }).select('id _id').lean();

        const accessibleFormIds = [];
        accessibleForms.forEach(f => {
          if (f.id) accessibleFormIds.push(f.id);
          if (f._id) accessibleFormIds.push(f._id.toString());
        });

        if (accessibleFormIds.length > 0) {
          tenantConditions.push({ formId: { $in: accessibleFormIds } });
        }
      }

      if (req.user?._id) {
        tenantConditions.push({ userId: req.user._id });
      }

      if (tenantConditions.length > 0) {
        andConditions.push({ $or: tenantConditions });
      }
    }

    if (formId) {
      query.formId = formId;
    }

    if (actionType && actionType !== 'ALL') {
      query.actionType = actionType;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      andConditions.push({
        $or: [
          { formTitle: regex },
          { userName: regex },
          { userEmail: regex },
          { batchId: regex },
          { fileName: regex },
          { 'details.chassisNumbers': regex },
          { actionTitle: regex }
        ]
      });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    console.log(`[IMPORT HISTORY] Fetching for user: ${req.user?.username} (${req.user?.role}), filter:`, JSON.stringify(query));

    const [items, total] = await Promise.all([
      BulkImportHistory.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      BulkImportHistory.countDocuments(query)
    ]);

    return res.json({
      success: true,
      data: {
        items,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('[IMPORT HISTORY] Error fetching import history:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch import history'
    });
  }
};

/**
 * GET /api/import-history/stats
 * Aggregate high-level stats for the timeline modal
 */
export const getImportHistoryStats = async (req, res) => {
  try {
    await syncLegacyExcelImports(req.user?.tenantId);

    const match = {};
    if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
      const tenantIdStr = req.user?.tenantId ? req.user.tenantId.toString() : null;
      const tenantIdObj = mongoose.Types.ObjectId.isValid(tenantIdStr)
        ? new mongoose.Types.ObjectId(tenantIdStr)
        : null;
      const tenantValues = [tenantIdStr, tenantIdObj].filter(Boolean);
      const tenantConditions = [];

      if (tenantValues.length > 0) {
        tenantConditions.push({ tenantId: { $in: tenantValues } });
      }

      if (tenantIdStr) {
        const accessibleForms = await Form.find({
          $or: [
            { isGlobal: true },
            { tenantId: { $in: tenantValues } },
            { sharedWithTenants: { $in: tenantValues } },
            { "chassisTenantAssignments.assignedTenants": tenantIdStr }
          ]
        }).select('id _id').lean();

        const accessibleFormIds = [];
        accessibleForms.forEach(f => {
          if (f.id) accessibleFormIds.push(f.id);
          if (f._id) accessibleFormIds.push(f._id.toString());
        });

        if (accessibleFormIds.length > 0) {
          tenantConditions.push({ formId: { $in: accessibleFormIds } });
        }
      }

      if (req.user?._id) {
        tenantConditions.push({ userId: req.user._id });
      }

      if (tenantConditions.length > 0) {
        match.$or = tenantConditions;
      }
    }

    const [stats] = await BulkImportHistory.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalBatches: { $sum: 1 },
          totalRecords: { $sum: "$dataCount.total" },
          totalSuccess: { $sum: "$dataCount.success" },
          totalFailed: { $sum: "$dataCount.failed" },
          uniqueUsers: { $addToSet: "$userName" },
          uniqueForms: { $addToSet: "$formTitle" }
        }
      }
    ]);

    // Top contributors
    const topContributors = await BulkImportHistory.aggregate([
      { $match: match },
      {
        $group: {
          _id: { userName: "$userName", userRole: "$userRole" },
          batchesCount: { $sum: 1 },
          recordsCount: { $sum: "$dataCount.total" },
          lastActive: { $max: "$createdAt" }
        }
      },
      { $sort: { recordsCount: -1 } },
      { $limit: 5 }
    ]);

    return res.json({
      success: true,
      data: {
        totalBatches: stats?.totalBatches || 0,
        totalRecords: stats?.totalRecords || 0,
        totalSuccess: stats?.totalSuccess || 0,
        totalFailed: stats?.totalFailed || 0,
        uniqueUsersCount: stats?.uniqueUsers?.length || 0,
        uniqueFormsCount: stats?.uniqueForms?.length || 0,
        topContributors: topContributors.map(c => ({
          userName: c._id.userName,
          userRole: c._id.userRole,
          batchesCount: c.batchesCount,
          recordsCount: c.recordsCount,
          lastActive: c.lastActive
        }))
      }
    });
  } catch (error) {
    console.error('[IMPORT HISTORY] Error fetching stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch history stats'
    });
  }
};

/**
 * GET /api/import-history/:id/responses
 * Fetch the individual responses associated with this import batch
 */
export const getImportHistoryResponses = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await BulkImportHistory.findById(id).lean();
    if (!history) {
      return res.status(404).json({ success: false, message: 'History record not found' });
    }

    let responseQuery = {};
    if (history.details?.responseIds && history.details.responseIds.length > 0) {
      responseQuery = { id: { $in: history.details.responseIds } };
    } else if (history.formId) {
      const targetDate = new Date(history.createdAt);
      const startDate = new Date(targetDate.getTime() - 1000 * 60 * 45); // +/- 45 mins
      const endDate = new Date(targetDate.getTime() + 1000 * 60 * 45);

      responseQuery = {
        questionId: history.formId,
        createdAt: { $gte: startDate, $lte: endDate }
      };
      if (history.details?.submitters?.length) {
        responseQuery.submittedBy = { $in: history.details.submitters };
      }
    } else {
      return res.json({ success: true, data: { history, responses: [] } });
    }

    const responses = await Response.find(responseQuery)
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    // Extract chassis number and summary for each response
    const formattedResponses = responses.map(r => {
      let chassis = '-';
      const answersObj = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});
      for (const [k, v] of Object.entries(answersObj)) {
        if (
          typeof v === 'string' &&
          v.trim() &&
          (k.toLowerCase().includes('chassis') || k.toLowerCase().includes('vin') || k.toLowerCase().includes('id number') || k === 'chassis_number')
        ) {
          chassis = v.trim();
          break;
        }
      }

      return {
        id: r.id,
        _id: r._id,
        questionId: r.questionId,
        chassisNumber: chassis,
        status: r.status,
        submittedBy: r.submittedBy,
        createdAt: r.createdAt,
        answersCount: Object.keys(answersObj).length,
        biwReview: r.biwReview
      };
    });

    return res.json({
      success: true,
      data: {
        history,
        responses: formattedResponses
      }
    });
  } catch (error) {
    console.error('[IMPORT HISTORY] Error fetching batch responses:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch batch responses' });
  }
};

/**
 * DELETE /api/import-history/:id
 * Remove a history log record with optional ?deleteResponses=true to also delete imported responses
 */
export const deleteImportHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteResponses } = req.query;

    const history = await BulkImportHistory.findById(id);
    if (!history) {
      return res.status(404).json({ success: false, message: 'History record not found' });
    }

    let deletedResponsesCount = 0;
    if (deleteResponses === 'true' || deleteResponses === true) {
      // 1. Delete by batchId (every batch response stores batchId)
      if (history.batchId) {
        const deleteRes = await Response.deleteMany({ batchId: history.batchId });
        deletedResponsesCount += (deleteRes.deletedCount || 0);
      }
      // 2. Delete by explicit responseIds if available
      if (history.details?.responseIds && history.details.responseIds.length > 0) {
        const deleteRes = await Response.deleteMany({ id: { $in: history.details.responseIds } });
        deletedResponsesCount += (deleteRes.deletedCount || 0);
      }
      // 3. Fallback: match by formId within creation time window
      if (deletedResponsesCount === 0 && history.formId) {
        const targetDate = new Date(history.createdAt);
        const startDate = new Date(targetDate.getTime() - 1000 * 60 * 60);
        const endDate = new Date(targetDate.getTime() + 1000 * 60 * 60);

        const deleteRes = await Response.deleteMany({
          questionId: history.formId,
          submittedBy: 'Excel Import',
          createdAt: { $gte: startDate, $lte: endDate }
        });
        deletedResponsesCount += (deleteRes.deletedCount || 0);
      }
    }

    await BulkImportHistory.findByIdAndDelete(id);

    return res.json({
      success: true,
      message: deleteResponses === 'true'
        ? `History record removed and ${deletedResponsesCount} uploaded responses deleted from database.`
        : 'History record removed successfully',
      deletedResponsesCount
    });
  } catch (error) {
    console.error('[IMPORT HISTORY] Error deleting history record:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete history record'
    });
  }
};
