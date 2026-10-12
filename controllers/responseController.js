import mongoose from 'mongoose';
import Response from '../models/Response.js';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';
import { v4 as uuidv4 } from 'uuid';
import { collectSubmissionMetadata } from '../services/locationService.js';
import { emitResponseCreated, emitResponseUpdated, emitResponseDeleted, emitImageProgress, emitBatchImported } from '../socket/socketHandler.js';
import { processResponseImages } from '../services/googleDriveService.js';
import { isGoogleDriveUrl } from '../services/googleDriveService.js';
import FormInvite from '../models/FormInvite.js';
import User from '../models/User.js';
import FormSession from '../models/FormSession.js';
import Review from '../models/Review.js';
import ChatMessage from '../models/ChatMessage.js';
import { recordImportHistory } from './importHistoryController.js';
import { invalidateCache } from '../utils/cache.js';

// ─── Shared/Linked-Tenant Response Access Helper ─────────────────────────────
// Response documents are always stamped with the FORM OWNER's tenantId (see
// createResponse: `tenantId: form.tenantId`), never the submitting user's own
// tenantId. Several endpoints used to bake `req.tenantFilter` (the acting
// user's own tenant) directly into their `Response.findOne`/`deleteMany`/etc.
// queries, which meant a user from a tenant a form was merely *shared* with
// could never find, update, dispatch, review, reassign, or delete responses
// on that shared form — every such call silently 404'd or matched nothing.
// This mirrors the correct pattern already used in getResponsesByForm:
// resolve the response/form first, then only enforce the tenant boundary
// when the acting user is neither the owner tenant, a shared tenant, nor
// granted chassis-level access.
const canAccessResponseTenant = async (req, response) => {
  if (!response) return false;
  if (req.user?.role === 'superadmin') return true;

  const or_conditions = [{ id: response.questionId }];
  if (mongoose.Types.ObjectId.isValid(response.questionId)) {
    or_conditions.push({ _id: response.questionId });
  }

  const form = await Form.findOne({
    $or: or_conditions,
  }).select('tenantId sharedWithTenants chassisTenantAssignments').lean();

  const userTenantIdStr = req.user?.tenantId ? req.user.tenantId.toString() : null;
  const isOwnerTenant = form?.tenantId && form.tenantId.toString() === userTenantIdStr;
  const isSharedTenant =
    form?.sharedWithTenants &&
    form.sharedWithTenants.some((t) => t.toString() === userTenantIdStr);
  const hasChassisShare =
    Array.isArray(form?.chassisTenantAssignments) &&
    form.chassisTenantAssignments.some(
      (a) => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr),
    );

  // Response.tenantId itself always equals the form owner's tenant, so as a
  // last resort also accept a direct match against it (covers responses
  // whose form record may have since been deleted/moved).
  const responseTenantIdStr = response.tenantId ? response.tenantId.toString() : null;
  const matchesResponseTenant = responseTenantIdStr && responseTenantIdStr === userTenantIdStr;

  return Boolean(isOwnerTenant || isSharedTenant || hasChassisShare || matchesResponseTenant);
};

// ─── Robust Date Parser for Excel Imports ─────────────────────────────────────
// Handles DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD-MMM-YYYY, Excel serial numbers,
// and ISO date strings into valid Date objects.
function parseExcelDateBackend(value) {
  if (!value && value !== 0) return undefined;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return undefined;
    const fullYear = value.getFullYear();
    if (fullYear >= 30000 && fullYear <= 100000) {
      return parseExcelDateBackend(fullYear);
    }
    // If it was read as UTC midnight from Excel, convert to safe midday UTC to prevent timezone boundary flip
    if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0) {
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0));
    }
    return value;
  }
  if (typeof value === 'number') {
    const isWholeDay = Math.abs(value - Math.round(value)) < 0.0001;
    const utcMs = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    if (!isNaN(d.getTime())) {
      if (isWholeDay) {
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
      }
      return d;
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Check if ISO string with extended 5-6 digit year (e.g. "+046364-12-31")
    const plusYearMatch = trimmed.match(/^\+0*(\d{5,6})/);
    if (plusYearMatch) {
      const serial = parseInt(plusYearMatch[1], 10);
      if (serial >= 30000 && serial <= 100000) {
        return parseExcelDateBackend(serial);
      }
    }

    // Check if date formatted with 5-6 digit year (e.g. "01/01/46364")
    const fiveDigitYearMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{5,6})/);
    if (fiveDigitYearMatch) {
      const serial = parseInt(fiveDigitYearMatch[3], 10);
      if (serial >= 30000 && serial <= 100000) {
        return parseExcelDateBackend(serial);
      }
    }

    const numVal = Number(trimmed);
    if (!isNaN(numVal) && numVal > 30000 && numVal < 100000) {
      return parseExcelDateBackend(numVal);
    }

    const monthNames = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
      apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
      aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
      nov: 10, november: 10, dec: 11, december: 11,
    };

    const dMonYMatch = trimmed.match(
      /^(\d{1,2})[-/.\s]+([a-zA-Z]+)[-/.\s]+(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(am|pm))?)?$/i
    );
    if (dMonYMatch) {
      const day = parseInt(dMonYMatch[1], 10);
      const mStr = dMonYMatch[2].toLowerCase();
      const month = monthNames[mStr];
      let year = parseInt(dMonYMatch[3], 10);
      if (year < 100) year += year < 50 ? 2000 : 1900;
      const hasTime = Boolean(dMonYMatch[4]);
      let hours = dMonYMatch[4] ? parseInt(dMonYMatch[4], 10) : 0;
      const minutes = dMonYMatch[5] ? parseInt(dMonYMatch[5], 10) : 0;
      const seconds = dMonYMatch[6] ? parseInt(dMonYMatch[6], 10) : 0;
      const ampm = dMonYMatch[7]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      if (month !== undefined && day >= 1 && day <= 31) {
        if (hasTime) {
          const d = new Date(year, month, day, hours, minutes, seconds);
          if (!isNaN(d.getTime())) return d;
        } else {
          return new Date(Date.UTC(year, month, day, 12, 0, 0));
        }
      }
    }

    const dmyMatch = trimmed.match(
      /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(am|pm))?)?$/i
    );
    if (dmyMatch) {
      const part1 = parseInt(dmyMatch[1], 10);
      const part2 = parseInt(dmyMatch[2], 10);
      let year = parseInt(dmyMatch[3], 10);
      const currentYear = new Date().getFullYear();
      const currentYearMod = currentYear % 100;
      if (year < 100) {
        year += year <= currentYearMod + 1 ? 2000 : 1900;
      } else if (year >= 100 && year < 1000) {
        year += 2000;
      }
      const hasTime = Boolean(dmyMatch[4]);
      let hours = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
      const minutes = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
      const seconds = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
      const ampm = dmyMatch[7]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      let day = part1;
      let month = part2 - 1;
      if (part1 <= 12 && part2 > 12) {
        day = part2;
        month = part1 - 1;
      }

      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        if (hasTime) {
          const d = new Date(year, month, day, hours, minutes, seconds);
          if (!isNaN(d.getTime())) return d;
        } else {
          return new Date(Date.UTC(year, month, day, 12, 0, 0));
        }
      }
    }

    const ymdMatch = trimmed.match(
      /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ ,T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(am|pm))?)?$/i
    );
    if (ymdMatch) {
      const year = parseInt(ymdMatch[1], 10);
      const month = parseInt(ymdMatch[2], 10) - 1;
      const day = parseInt(ymdMatch[3], 10);
      const hasTime = Boolean(ymdMatch[4]);
      let hours = ymdMatch[4] ? parseInt(ymdMatch[4], 10) : 0;
      const minutes = ymdMatch[5] ? parseInt(ymdMatch[5], 10) : 0;
      const seconds = ymdMatch[6] ? parseInt(ymdMatch[6], 10) : 0;
      const ampm = ymdMatch[7]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        if (hasTime) {
          const d = new Date(year, month, day, hours, minutes, seconds);
          if (!isNaN(d.getTime())) return d;
        } else {
          return new Date(Date.UTC(year, month, day, 12, 0, 0));
        }
      }
    }

    const dmMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})$/);
    if (dmMatch) {
      const part1 = parseInt(dmMatch[1], 10);
      const part2 = parseInt(dmMatch[2], 10);
      let day = part1;
      let month = part2 - 1;
      if (part1 <= 12 && part2 > 12) {
        day = part2;
        month = part1 - 1;
      }
      const year = new Date().getFullYear();
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month, day, 12, 0, 0));
      }
    }

    const singleDayMatch = trimmed.match(/^(\d{1,2})$/);
    if (singleDayMatch) {
      const day = parseInt(singleDayMatch[1], 10);
      if (day >= 1 && day <= 31) {
        const now = new Date();
        return new Date(Date.UTC(now.getFullYear(), now.getMonth(), day, 12, 0, 0));
      }
    }

    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      if (parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0 && parsed.getUTCSeconds() === 0) {
        return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12, 0, 0));
      }
      return parsed;
    }
  }
  return undefined;
}

const extractAnswerString = (ans) => {
  if (ans === null || ans === undefined) return '';
  if (typeof ans === 'object') {
    if (ans.chassisNumber !== undefined && ans.chassisNumber !== null) {
      return String(ans.chassisNumber).trim();
    }
    if (ans.value !== undefined && ans.value !== null) {
      return String(ans.value).trim();
    }
    if (ans.text !== undefined && ans.text !== null) {
      return String(ans.text).trim();
    }
    if (ans.chassis !== undefined && ans.chassis !== null) {
      return String(ans.chassis).trim();
    }
    return '';
  }
  return String(ans).trim();
};

const getRelatedFormsAndIds = async (form, baseFormId) => {
  const formIds = [form.id, form._id ? form._id.toString() : null, baseFormId].filter(Boolean);
  const relatedForms = [form];

  if (form.parentFormId) {
    const pStr = form.parentFormId.toString();
    formIds.push(pStr);
    try {
      const parentForm = await Form.findOne({
        $or: [
          { id: pStr },
          { _id: mongoose.Types.ObjectId.isValid(pStr) ? new mongoose.Types.ObjectId(pStr) : null }
        ].filter(Boolean)
      }).lean();
      if (parentForm) {
        relatedForms.push(parentForm);
        if (parentForm.id) formIds.push(parentForm.id);
        if (parentForm._id) formIds.push(parentForm._id.toString());
        if (Array.isArray(parentForm.childForms)) {
          parentForm.childForms.forEach(cf => {
            if (cf.formId) formIds.push(cf.formId);
          });
        }
      }
    } catch (err) {
      console.warn('Error fetching parentForm in getRelatedFormsAndIds:', err);
    }
  }

  try {
    const targetIds = [form.id, form._id ? form._id.toString() : null, baseFormId].filter(Boolean);
    const parentsByChild = await Form.find({
      'childForms.formId': { $in: targetIds }
    }).lean();

    parentsByChild.forEach(pf => {
      relatedForms.push(pf);
      if (pf.id) formIds.push(pf.id);
      if (pf._id) formIds.push(pf._id.toString());
      if (Array.isArray(pf.childForms)) {
        pf.childForms.forEach(cf => {
          if (cf.formId) formIds.push(cf.formId);
        });
      }
    });
  } catch (err) {
    console.warn('Error checking parentsByChild in getRelatedFormsAndIds:', err);
  }

  if (Array.isArray(form.childForms)) {
    form.childForms.forEach(cf => {
      if (cf.formId) formIds.push(cf.formId);
    });
  }

  const uniqueFormIds = Array.from(new Set(formIds));
  return { formIds: uniqueFormIds, relatedForms };
};

const getRelatedFormIds = async (form, baseFormId) => {
  const { formIds } = await getRelatedFormsAndIds(form, baseFormId);
  return formIds;
};

const getThisFormIds = (form, baseFormId) => {
  const formIds = [
    form.id,
    form._id ? form._id.toString() : null,
    baseFormId
  ].filter(Boolean);
  return Array.from(new Set(formIds));
};

const getThisFormExtraQuestionIds = (form) => {
  const extraQIds = [];
  const collectQ = (qs) => {
    (qs || []).forEach(q => {
      if (q.id) extraQIds.push(q.id);
      if (q._id) extraQIds.push(q._id.toString());
      if (q.text) extraQIds.push(q.text);
      if (q.followUpQuestions) collectQ(q.followUpQuestions);
    });
  };
  (form.sections || []).forEach(s => collectQ(s.questions));
  collectQ(form.followUpQuestions);
  return Array.from(new Set(extraQIds));
};

const buildChassisOrConditions = (questionId, trackingQId, strAnswer, extraQuestionIds = []) => {
  const trimmed = String(strAnswer || '').trim();
  if (!trimmed) return [];
  const possibleStrings = Array.from(new Set([
    trimmed,
    trimmed.toLowerCase(),
    trimmed.toUpperCase(),
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
  ]));

  const orConditions = [
    { chassisNumber: { $in: possibleStrings } },
    { chassisNumber: trimmed },
    { [`answers.${trackingQId}`]: { $in: possibleStrings } },
    { [`answers.${questionId}`]: { $in: possibleStrings } },
    { [`answers._${questionId}`]: { $in: possibleStrings } },
    { [`answers._${trackingQId}`]: { $in: possibleStrings } },
    { [`answers.${trackingQId}.chassisNumber`]: { $in: possibleStrings } },
    { [`answers.${questionId}.chassisNumber`]: { $in: possibleStrings } },
    { [`answers.${trackingQId}.value`]: { $in: possibleStrings } },
    { [`answers.${questionId}.value`]: { $in: possibleStrings } },
    { 'answers.chassis_number': { $in: possibleStrings } },
    { 'answers.chassis_number.chassisNumber': { $in: possibleStrings } },
    { 'answers.chassisNumber': { $in: possibleStrings } },
    { 'answers.id_number': { $in: possibleStrings } },
    { 'answers.idNumber': { $in: possibleStrings } },
    { 'answers.Identification': { $in: possibleStrings } },
    { 'answers.identification': { $in: possibleStrings } },
    { 'answers.Identification Number': { $in: possibleStrings } },
    { 'answers.identification_number': { $in: possibleStrings } },
    { 'answers.identificationNumber': { $in: possibleStrings } },
    { 'answers.IDENTIFICATION NUMBER': { $in: possibleStrings } },
    { 'answers.Identification No': { $in: possibleStrings } },
    { 'answers.identification_no': { $in: possibleStrings } },
    { 'answers.ID number': { $in: possibleStrings } },
    { 'answers.ID Number': { $in: possibleStrings } },
    { 'answers.ID NUMBER': { $in: possibleStrings } },
    { 'answers.ID_NUMBER': { $in: possibleStrings } },
    { 'answers.chassis_no': { $in: possibleStrings } },
    { 'answers.chassisNo': { $in: possibleStrings } },
    { 'answers.Chassis / VIN': { $in: possibleStrings } },
    { 'answers.VIN': { $in: possibleStrings } },
  ];

  (extraQuestionIds || []).forEach(qId => {
    if (qId && qId !== questionId && qId !== trackingQId) {
      orConditions.push({ [`answers.${qId}`]: { $in: possibleStrings } });
      orConditions.push({ [`answers.${qId}.chassisNumber`]: { $in: possibleStrings } });
      orConditions.push({ [`answers.${qId}.value`]: { $in: possibleStrings } });
    }
  });

  const numAnswer = Number(trimmed);
  if (!isNaN(numAnswer)) {
    orConditions.push({ chassisNumber: String(numAnswer) });
    orConditions.push({ chassisNumber: numAnswer });
    orConditions.push({ [`answers.${trackingQId}`]: numAnswer });
    orConditions.push({ [`answers.${questionId}`]: numAnswer });
    orConditions.push({ [`answers._${questionId}`]: numAnswer });
    orConditions.push({ [`answers._${trackingQId}`]: numAnswer });
    orConditions.push({ [`answers.${trackingQId}.chassisNumber`]: numAnswer });
    orConditions.push({ [`answers.${questionId}.chassisNumber`]: numAnswer });
    orConditions.push({ [`answers.${trackingQId}.value`]: numAnswer });
    orConditions.push({ [`answers.${questionId}.value`]: numAnswer });
    orConditions.push({ 'answers.chassis_number': numAnswer });
    orConditions.push({ 'answers.chassisNumber': numAnswer });
    orConditions.push({ 'answers.id_number': numAnswer });
    orConditions.push({ 'answers.idNumber': numAnswer });
  }

  return orConditions;
};

export const createResponse = async (req, res) => {
  try {
    console.log('[CREATE RESPONSE] === START ===');
    console.log('[CREATE RESPONSE] req.user:', req.user);
    console.log('[CREATE RESPONSE] req.user?._id:', req.user?._id);
    console.log('[CREATE RESPONSE] req.user?.role:', req.user?.role);
    console.log('[CREATE RESPONSE] req.user?.email:', req.user?.email);
    console.log('[CREATE RESPONSE] req.user?.username:', req.user?.username);
    console.log('[CREATE RESPONSE] auth header exists:', !!req.header('Authorization'));
    console.log('[CREATE RESPONSE] auth header value:', req.header('Authorization')?.substring(0, 30) + '...');
    console.log('[CREATE RESPONSE] body.submittedBy:', req.body.submittedBy);
    console.log('[CREATE RESPONSE] body.submitterContact:', req.body.submitterContact);

    const {
      questionId: bodyFormId,
      answers,
      parentResponseId,
      submittedBy,
      submitterContact,
      submissionMetadata: bodyMetadata,
      inviteId,
      isSectionSubmit,
      sectionIndex,
      sessionId,
      startedAt,
      completedAt
    } = req.body;
    const { tenantSlug, formId: paramFormId } = req.params;
    const questionId = paramFormId || bodyFormId;

    if (!questionId) {
      return res.status(400).json({
        success: false,
        message: 'Form ID is required'
      });
    }

    let form;
    let submissionTimeSpent = 0;
    let formSession = null;
    let actualStartedAt = startedAt ? new Date(startedAt) : null;
    let actualCompletedAt = completedAt ? new Date(completedAt) : new Date();
    // ========== TIMING CALCULATION ==========
    // Calculate time if we have start time
    if (actualStartedAt) {
      submissionTimeSpent = Math.floor((actualCompletedAt - actualStartedAt) / 1000);
    }

    // Try to find FormSession if we have sessionId
    if (sessionId) {
      try {
        const FormSession = mongoose.model('FormSession');
        formSession = await FormSession.findOne({ sessionId });

        if (formSession) {
          // Use session data for more accurate timing
          if (formSession.startedAt) {
            actualStartedAt = formSession.startedAt;
            actualCompletedAt = new Date();
            submissionTimeSpent = Math.floor((actualCompletedAt - formSession.startedAt) / 1000);
          }

          // Update session as completed (only for final submission, not partial)
          if (!isSectionSubmit) {
            formSession.completedAt = actualCompletedAt;
            formSession.timeSpent = submissionTimeSpent;
            formSession.status = 'completed';
            formSession.answers = answers;
            await formSession.save();
            console.log(`[TIME TRACKING] Session ${sessionId} completed in ${submissionTimeSpent} seconds`);
          } else {
            // For partial submissions, just update last activity
            formSession.lastActivityAt = actualCompletedAt;
            await formSession.save();
            console.log(`[TIME TRACKING] Partial submission for session ${sessionId}`);
          }
        }
      } catch (err) {
        console.error('Error finding FormSession:', err);
      }
    } else if (req.formSessionId) {
      // Fallback to sessionId stored in request by trackFormStart middleware
      try {
        const FormSession = mongoose.model('FormSession');
        formSession = await FormSession.findOne({ sessionId: req.formSessionId });
        if (formSession && !isSectionSubmit) {
          actualStartedAt = formSession.startedAt;
          actualCompletedAt = new Date();
          submissionTimeSpent = Math.floor((actualCompletedAt - formSession.startedAt) / 1000);

          formSession.completedAt = actualCompletedAt;
          formSession.timeSpent = submissionTimeSpent;
          formSession.status = 'completed';
          formSession.answers = answers;
          await formSession.save();
        }
      } catch (err) {
        console.error('Error finding FormSession by formSessionId:', err);
      }
    }

    // If no session exists and this is a final submission, try to find one by matching time window
    if (!formSession && !isSectionSubmit) {
      try {
        const FormSession = mongoose.model('FormSession');
        // Look for recent session (last 2 hours) from this user/IP
        const recentSession = await FormSession.findOne({
          formId: questionId,
          userId: req.user?._id || null,
          status: 'in-progress',
          startedAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } // Last 2 hours
        }).sort({ startedAt: -1 });

        if (recentSession) {
          submissionTimeSpent = Math.floor((new Date() - recentSession.startedAt) / 1000);
          recentSession.completedAt = new Date();
          recentSession.timeSpent = submissionTimeSpent;
          recentSession.status = 'completed';
          recentSession.answers = answers;
          await recentSession.save();
          formSession = recentSession;
          console.log(`[TIME TRACKING] Found orphaned session, time spent: ${submissionTimeSpent} seconds`);
        }
      } catch (err) {
        console.error('Error finding recent session:', err);
      }
    }

    // Log timing information
    const formatTimeDisplay = (seconds) => {
      if (!seconds || seconds < 60) return `${seconds || 0}s`;
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    };

    console.log(`[TIME TRACKING] Form submission - Time spent: ${formatTimeDisplay(submissionTimeSpent)}`);

    // ========== FORM VALIDATION (Keep your existing code) ==========


    if (!questionId) {
      return res.status(400).json({
        success: false,
        message: 'Form ID is required'
      });
    }

    console.log(`[CREATE RESPONSE] FormID: ${questionId}, TenantSlug: ${tenantSlug || 'N/A'}`);
    console.log(`[CREATE RESPONSE DEBUG] Step 1: Starting form lookup`);


    const searchConditions = [{ id: questionId }];
    if (mongoose.Types.ObjectId.isValid(questionId)) {
      searchConditions.push({ _id: new mongoose.Types.ObjectId(String(questionId)) }, { _id: questionId });
    }

    form = await Form.findOne({ $or: searchConditions });

    if (!form && tenantSlug) {
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });
      if (tenant) {
        form = await Form.findOne({ $or: searchConditions, tenantId: tenant._id });
      }
    }

    if (!form) {
      return res.status(404).json({
        success: false,
        message: `Form not found with ID: ${questionId}`
      });
    }

    // ========== INVITE HANDLING (Keep your existing code) ==========
    let inviteStatus = null;
    let inviteObj = null;

    if (inviteId) {
      console.log(`[INVITE] Processing response with inviteId: ${inviteId}`);

      const invite = await FormInvite.findOne({
        formId: questionId,
        inviteId: inviteId
      });

      inviteObj = invite;

      if (inviteObj) {
        if (inviteObj.status === 'responded' && !isSectionSubmit) {
          console.log(`[INVITE] Invite ${inviteId} was already responded.`);
        }

        if (!isSectionSubmit) {
          inviteObj.status = 'responded';
          inviteObj.respondedAt = new Date();
          await inviteObj.save().catch(e => console.error('[INVITE] Error saving:', e));
          inviteStatus = 'responded';
          console.log(`[INVITE] Updated invite ${inviteId} to responded status`);
        } else {
          console.log(`[INVITE] Partial submission for invite ${inviteId}`);
        }
      }
    }

    // ========== SUBMISSION METADATA (Keep your existing code) ==========
    console.log(`[CREATE RESPONSE DEBUG] Step 4: Starting submission metadata collection`);
    const submissionMetadata = await collectSubmissionMetadata(req, {
      includeLocation: form.locationEnabled !== false,
    });

    if (bodyMetadata && bodyMetadata.source) {
      submissionMetadata.source = bodyMetadata.source;
    } else if (inviteId && inviteObj) {
      // Use the already found invite object
      if (inviteObj.notificationChannels && inviteObj.notificationChannels.length > 0) {
        // Preference 1: Use the explicit notification channel (email, sms, whatsapp)
        submissionMetadata.source = inviteObj.notificationChannels[0];
      } else if (inviteObj.phone && !inviteObj.email) {
        // Preference 2: If only phone is present, it's likely SMS
        submissionMetadata.source = 'sms';
      } else if (inviteObj.email) {
        // Preference 3: If email is present, it's likely Email
        submissionMetadata.source = 'email';
      } else {
        // Fallback
        submissionMetadata.source = 'email';
      }
    }


    if (form.locationEnabled !== false && req.body.location && typeof req.body.location === 'object') {
      const { latitude, longitude, accuracy, source, capturedAt, city, region, country } = req.body.location;
      submissionMetadata.capturedLocation = {
        latitude: typeof latitude === 'number' ? latitude : null,
        longitude: typeof longitude === 'number' ? longitude : null,
        accuracy: typeof accuracy === 'number' ? accuracy : null,
        source: typeof source === 'string' ? source : 'browser',
        city: typeof city === 'string' ? city : null,
        region: typeof region === 'string' ? region : null,
        country: typeof country === 'string' ? country : null,
        capturedAt: capturedAt ? new Date(capturedAt) : new Date()
      };
      console.log('[DEBUG] Captured location stored:', submissionMetadata.capturedLocation);
    }

    // Helper function to recursively collect all questions
    const collectAllQuestions = (questions, result = []) => {
      if (!Array.isArray(questions)) return result;

      questions.forEach(q => {
        result.push(q);
        if (Array.isArray(q.followUpQuestions)) {
          collectAllQuestions(q.followUpQuestions, result);
        }
      });

      return result;
    };



    // ========== SCORE CALCULATION (Keep your existing code) ==========
    const allQuestions = [];
    if (form.sections) {
      form.sections.forEach(section => {
        if (section.questions) {
          collectAllQuestions(section.questions, allQuestions);

        }
      });
    }
    if (form.followUpQuestions) {
      collectAllQuestions(form.followUpQuestions, allQuestions);

    }

    let correct = 0;
    let total = 0;
    const questionResults = {};

    allQuestions.forEach(question => {
      if (question.type === 'yesNoNA') {
        total++;
        const answer = answers[question.id];
        let isCorrect = false;

        if (answer && String(answer).toLowerCase() === 'yes') {
          isCorrect = true;
          correct++;
        }

        questionResults[question.id] = {
          isCorrect,
          userAnswer: answer,
          questionType: 'yesNoNA',
          scoring: { yes: 1, no: 0, nOrNA: 0 }
        };
      } else {
        const hasCorrectAnswer = question.correctAnswer || (question.correctAnswers && question.correctAnswers.length > 0);

        if (hasCorrectAnswer) {
          total++;
          const answer = answers[question.id];
          let isCorrect = false;

          if (question.correctAnswers && question.correctAnswers.length > 0) {
            if (Array.isArray(answer)) {
              const normalizedAnswer = answer.map(a => String(a).toLowerCase());
              const normalizedCorrect = question.correctAnswers.map(a => String(a).toLowerCase());
              isCorrect = normalizedAnswer.length === normalizedCorrect.length &&
                normalizedAnswer.every(a => normalizedCorrect.includes(a));
            } else {
              const normalizedAnswer = String(answer).toLowerCase();
              const normalizedCorrect = question.correctAnswers.map(a => String(a).toLowerCase());
              isCorrect = normalizedCorrect.includes(normalizedAnswer);
            }
          } else if (question.correctAnswer) {
            if (Array.isArray(answer)) {
              isCorrect = answer.some(a => String(a).toLowerCase() === String(question.correctAnswer).toLowerCase());
            } else {
              isCorrect = String(answer).toLowerCase() === String(question.correctAnswer).toLowerCase();
            }
          }

          if (isCorrect) {
            correct++;
          }

          questionResults[question.id] = {
            isCorrect,
            userAnswer: answer,
            correctAnswer: question.correctAnswers || [question.correctAnswer]
          };
        }
      }
    });

    // Calculate ranks for specific questions
    const responseRanks = {};
    const formObj = form.toObject();
    const allQs = [];

    // Recursive helper to collect all questions (used ONLY for initial collection)
    const collectFromQuestions = (questions) => {
      if (!Array.isArray(questions)) return;
      questions.forEach(q => {
        allQs.push(q);
        if (Array.isArray(q.followUpQuestions)) {
          collectFromQuestions(q.followUpQuestions);
        }
      });
    };
    if (formObj.sections) {
      formObj.sections.forEach(section => {
        if (section.questions) {
          collectFromQuestions(section.questions);
        }
      });
    }
    if (formObj.followUpQuestions) {
      collectFromQuestions(formObj.followUpQuestions);
    }

    // Separate helper that collects question IDs WITHOUT mutating allQs
    const collectExtraQuestionIds = (questions) => {
      const ids = [];
      if (!Array.isArray(questions)) return ids;
      questions.forEach(q => {
        if (q.id) ids.push(q.id);
        if (q._id) ids.push(q._id.toString());
        if (Array.isArray(q.followUpQuestions)) {
          ids.push(...collectExtraQuestionIds(q.followUpQuestions));
        }
      });
      return ids;
    };

    // Filter to only tracking-enabled questions and deduplicate by ID
    const processedQIds = new Set();
    const trackingQuestions = allQs.filter(q => {
      const qId = q.id;
      if (!qId || processedQIds.has(qId)) return false;
      const isTracking =
        q.trackResponseRank === true ||
        q.trackResponseRank === "true" ||
        q.trackResponseQuestion === true ||
        q.trackResponseQuestion === "true";
      if (isTracking) processedQIds.add(qId);
      return isTracking;
    });

    console.log(`[RANK] ${allQs.length} questions in form, ${trackingQuestions.length} with tracking enabled`);

    if (trackingQuestions.length > 0) {
      // Scope rank stamping strictly to this form alone
      const formIds = getThisFormIds(form, questionId);
      const extraQIds = getThisFormExtraQuestionIds(form);

      // Build and run all rank queries in parallel
      const rankPromises = trackingQuestions.map(async (question) => {
        const qId = question.id;
        const trackingQId = `${qId}_tracking`;
        const rawAns = answers[qId] !== undefined ? answers[qId] : answers[trackingQId];
        const strAnswer = extractAnswerString(rawAns);

        if (strAnswer === "") return;

        const orConditions = buildChassisOrConditions(qId, trackingQId, strAnswer, extraQIds);

        const query = {
          $or: [
            { questionId: { $in: formIds } },
            { formId: { $in: formIds } }
          ],
          $and: [
            { $or: orConditions }
          ],
          isSectionSubmit: { $ne: true }
        };

        try {
          const count = await Response.countDocuments(query);
          responseRanks[qId] = count + 1;
        } catch (countError) {
          console.error(`[RANK ERROR] Failed to count for question ${qId}:`, countError);
        }
      });

      await Promise.all(rankPromises);
      console.log(`[RANK] Completed rank calculation for ${trackingQuestions.length} questions`);
    }


    let displayName = 'Anonymous';

    if (req.body.submittedBy && req.body.submittedBy !== 'Anonymous') {
      displayName = req.body.submittedBy;
    } else if (req.user) {
      // Try to get full name from firstName + lastName
      if (req.user.firstName || req.user.lastName) {
        displayName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
      }
      // Fallback to username
      if (displayName === '' && req.user.username) {
        displayName = req.user.username;
      }
      // Fallback to email
      if (displayName === '' && req.user.email) {
        displayName = req.user.email;
      }
    }

    // Extract chassis number from answers
    const chassisVal = extractAnswerString(
      answers?.chassis_number ||
      answers?.chassisNumber ||
      answers?.id_number ||
      answers?.idNumber ||
      answers?.['ID number'] ||
      answers?.['Chassis / VIN'] ||
      answers?.['Chassis No'] ||
      answers?.['CHASSIS NUMBER'] ||
      req.body.chassisNumber
    );

    let resolvedParentResponseId = parentResponseId;
    // Auto-match to parent response by chassis if form is a child/follow-up form and parentResponseId was not passed
    if (!resolvedParentResponseId && form?.parentFormId && chassisVal) {
      try {
        const parentFormIds = [form.parentFormId.toString()];
        const parentResp = await Response.findOne({
          questionId: { $in: parentFormIds },
          isSectionSubmit: { $ne: true },
          $or: [
            { chassisNumber: chassisVal },
            { 'answers.chassis_number': chassisVal },
            { 'answers.chassisNumber': chassisVal },
            { 'answers.id_number': chassisVal },
            { 'answers.idNumber': chassisVal },
            { 'answers.Chassis / VIN': chassisVal },
            { 'answers.Chassis No': chassisVal },
            { 'answers.CHASSIS NUMBER': chassisVal }
          ]
        }).sort({ createdAt: -1 }).lean();
        if (parentResp) {
          resolvedParentResponseId = parentResp.id || (parentResp._id ? parentResp._id.toString() : null);
        }
      } catch (pmErr) {
        console.warn('[CREATE RESPONSE] Error auto-linking parent response:', pmErr);
      }
    }

    // ========== DUPLICATE SUBMISSION PREVENTION ==========
    const targetSessionId = sessionId || formSession?.sessionId;
    if (targetSessionId && !isSectionSubmit) {
      const existingSessionResponse = await Response.findOne({
        questionId,
        $or: [
          { sessionId: targetSessionId },
          { 'submissionMetadata.sessionId': targetSessionId }
        ]
      });
      if (existingSessionResponse) {
        console.log(`[CREATE RESPONSE] Duplicate submission blocked: sessionId ${targetSessionId} already submitted as response ${existingSessionResponse.id}`);
        const existingAnswers = existingSessionResponse.answers instanceof Map ? Object.fromEntries(existingSessionResponse.answers) : existingSessionResponse.answers;
        return res.status(200).json({
          success: true,
          message: 'Response already submitted successfully',
          data: {
            response: {
              ...existingSessionResponse.toObject(),
              answers: existingAnswers
            }
          }
        });
      }
    }

    if (chassisVal && !isSectionSubmit) {
      const recentWindow = new Date(Date.now() - 50 * 1000);
      const duplicateFilter = {
        questionId,
        chassisNumber: chassisVal,
        createdAt: { $gte: recentWindow },
        isSectionSubmit: { $ne: true }
      };
      if (req.user?._id) {
        duplicateFilter.createdBy = req.user._id;
      } else if (displayName && displayName !== 'Anonymous') {
        duplicateFilter.submittedBy = displayName;
      }
      const recentDuplicate = await Response.findOne(duplicateFilter);
      if (recentDuplicate) {
        console.log(`[CREATE RESPONSE] Rapid duplicate blocked for chassis ${chassisVal} on form ${questionId}`);
        const dupAnswers = recentDuplicate.answers instanceof Map ? Object.fromEntries(recentDuplicate.answers) : recentDuplicate.answers;
        return res.status(200).json({
          success: true,
          message: 'Response already submitted successfully',
          data: {
            response: {
              ...recentDuplicate.toObject(),
              answers: dupAnswers
            }
          }
        });
      }
    }

    // ========== CREATE RESPONSE IMMEDIATELY FOR SUPER FAST SUBMISSION ==========
    const responseData = {
      id: uuidv4(),
      questionId,
      answers: new Map(Object.entries(answers || {})),
      responseRanks: new Map(Object.entries(responseRanks || {})),
      driveBackupUrls: {},
      imageProcessing: {
        totalImages: 0,
        processedImages: 0,
        driveBackups: 0,
        folderStructure: null,
        processingTime: 0,
        status: 'completed'
      },
      parentResponseId: resolvedParentResponseId || undefined,
      chassisNumber: chassisVal || undefined,
      submittedBy: displayName,
      submitterContact: {
        email: req.body.submitterContact?.email || req.user?.email,
        phone: req.body.submitterContact?.phone
      },

      // ========== ADD TOP-LEVEL TIMING FIELDS ==========
      timeSpent: submissionTimeSpent,
      sessionId: sessionId || formSession?.sessionId || null,
      startedAt: actualStartedAt,
      completedAt: actualCompletedAt,
      questionTimings: formSession?.questionTimings || [],

      submissionMetadata: {
        ...submissionMetadata,
        timeSpent: submissionTimeSpent,
        sessionId: sessionId || formSession?.sessionId || null,
        startedAt: actualStartedAt,
        completedAt: actualCompletedAt,
        timeSpentFormatted: formatTimeDuration(submissionTimeSpent),
        questionTimings: formSession?.questionTimings,
        sectionTimings: formSession?.sectionTimings
      },

      status: 'pending',
      createdBy: req.user?._id || null,
      isSectionSubmit: !!isSectionSubmit,
      sectionIndex: sectionIndex || null,
      tenantId: form.tenantId,
      score: { correct, total },
      inviteId: inviteId || null
    };

    const response = new Response(responseData);
    await response.save();

    const answersObj = response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers;
    const ranksObj = response.responseRanks instanceof Map ? Object.fromEntries(response.responseRanks) : response.responseRanks;

    // Emit real-time event for new response
    const livePayload = {
      id: response.id,
      questionId: response.questionId,
      status: response.status,
      submittedBy: response.submittedBy,
      createdAt: response.createdAt,
      answers: answersObj,
      inviteId: inviteId || null,
      timeSpent: submissionTimeSpent,
      responseRanks: ranksObj,
    };
    emitResponseCreated(questionId, livePayload);
    if (form?._id && String(form._id) !== String(questionId)) {
      emitResponseCreated(String(form._id), livePayload);
    }
    if (form?.id && String(form.id) !== String(questionId)) {
      emitResponseCreated(String(form.id), livePayload);
    }

    // Check OAuth configuration for non-blocking background drive upload
    const driveConfigured = !!(process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN);

    if (driveConfigured) {
      // Run Drive backup in background without blocking response submission
      setImmediate(async () => {
        try {
          const metadata = {
            tenantId: form.tenantId,
            formId: questionId,
            submissionId: `resp-${Date.now()}`,
            submissionTimestamp: Date.now(),
            driveEnabled: true
          };
          const processingResult = await processResponseImages(
            answers,
            metadata,
            null,
            `response-${Date.now()}`
          );
          if (processingResult && processingResult.processedAnswers) {
            await Response.updateOne(
              { id: response.id },
              {
                $set: {
                  answers: processingResult.processedAnswers,
                  driveBackupUrls: processingResult.driveBackupUrls || {},
                  imageProcessing: {
                    totalImages: processingResult.stats?.totalImages || 0,
                    processedImages: processingResult.stats?.processedImages || 0,
                    driveBackups: processingResult.stats?.successfulDriveBackups || 0,
                    folderStructure: processingResult.folderStructure || null,
                    processingTime: Date.now() - (processingResult.stats?.startTime || Date.now()),
                    status: processingResult.error ? 'partial' : 'completed'
                  }
                }
              }
            );
          }
        } catch (bgError) {
          console.error('[BACKGROUND IMAGE PROCESS ERROR]', bgError);
        }
      });
    }

    // ========== RETURN RESPONSE IMMEDIATELY (<100ms) ==========
    res.status(201).json({
      success: true,
      message: 'Response submitted successfully',
      data: {
        response: {
          id: response.id,
          questionId: response.questionId,
          answers: answersObj,
          responseRanks: ranksObj,
          parentResponseId: response.parentResponseId,
          submittedBy: response.submittedBy,
          submitterContact: response.submitterContact,
          status: response.status,
          createdAt: response.createdAt,
          updatedAt: response.updatedAt,
          inviteId: inviteId || null,
          imageProcessing: {
            totalImages: 0,
            driveBackups: 0,
            folderPath: null
          },
          timeSpent: submissionTimeSpent,
          timeSpentFormatted: formatTimeDuration(submissionTimeSpent),
          startedAt: actualStartedAt,
          completedAt: actualCompletedAt,
          questionTimings: formSession?.questionTimings,
          sectionTimings: formSession?.sectionTimings
        },
        score: {
          correct,
          total,
          percentage: total > 0 ? Math.round((correct / total) * 100) : 0
        },
        imageProcessing: {
          status: 'completed',
          stats: {}
        },
        inviteStatus: inviteStatus,
        timing: {
          timeSpent: submissionTimeSpent,
          timeSpentFormatted: formatTimeDuration(submissionTimeSpent),
          startedAt: actualStartedAt,
          completedAt: actualCompletedAt,
          hasSession: !!formSession,
          sessionId: sessionId || formSession?.sessionId
        }
      }
    });

  } catch (error) {
    console.error('Create response error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}


function formatTimeDuration(seconds) {
  if (!seconds || seconds < 0) return '0 seconds';
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    if (remainingSeconds === 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }
  return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
}
export const batchImportResponses = async (req, res) => {
  // Declare batchId at the function scope
  let batchId;

  try {
    console.log('=== BATCH IMPORT ===');

    const { questionId, questionID, responses } = req.body;
    const actualQuestionId = questionId || questionID;

    // Set batchId at function scope
    batchId = req.body.batchId || `batch-${Date.now()}`;

    console.log('Batch ID:', batchId);
    console.log('Searching for form ID:', actualQuestionId);
    console.log('[BATCH IMPORT DEBUG] First response received:', JSON.stringify(responses[0]));

    if (!actualQuestionId || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request'
      });
    }

    // Find form (without isVisible check for now)
    const form = await Form.findOne({ id: actualQuestionId });
    if (!form) {
      return res.status(404).json({
        success: false,
        message: `Form with ID "${actualQuestionId}" not found`
      });
    }

    // STEP 0: Prefetch metadata and form questions once
    const submissionMetadata = await collectSubmissionMetadata(req, {
      includeLocation: form.locationEnabled !== false,
    });

    // Helper to safely extract chassis string from answers
    const extractChassisFromAns = (ans) => {
      if (!ans) return null;
      const plain = ans instanceof Map ? Object.fromEntries(ans) : ans;
      const val = extractAnswerString(
        plain.chassis_number ||
        plain.chassisNumber ||
        plain.id_number ||
        plain.idNumber ||
        plain['ID number'] ||
        plain['Chassis / VIN'] ||
        plain['Chassis No'] ||
        plain['CHASSIS NUMBER']
      );
      return val ? String(val).trim() : null;
    };

    // Pre-fetch parent responses by chassis if this is a follow-up form or follow-up/template 2 import batch
    const isFollowUpBatch = Boolean(form.parentFormId) || String(batchId).includes('-t2') || String(batchId).includes('-fu-');
    const chassisToParentMap = new Map();

    if (isFollowUpBatch) {
      const chassisListInBatch = responses
        .map(r => extractChassisFromAns(r.answers) || (r.chassisNumber ? String(r.chassisNumber).trim() : null))
        .filter(Boolean);
      const uniqueChassisInBatch = Array.from(new Set(chassisListInBatch));

      if (uniqueChassisInBatch.length > 0) {
        const parentFormIds = form.parentFormId
          ? [form.parentFormId.toString()]
          : [actualQuestionId, form.id, form._id ? form._id.toString() : null].filter(Boolean);

        const parentQuery = {
          questionId: { $in: parentFormIds },
          isSectionSubmit: { $ne: true },
          $or: [
            { chassisNumber: { $in: uniqueChassisInBatch } },
            { 'answers.chassis_number': { $in: uniqueChassisInBatch } },
            { 'answers.chassisNumber': { $in: uniqueChassisInBatch } },
            { 'answers.id_number': { $in: uniqueChassisInBatch } },
            { 'answers.idNumber': { $in: uniqueChassisInBatch } },
            { 'answers.Chassis / VIN': { $in: uniqueChassisInBatch } },
            { 'answers.Chassis No': { $in: uniqueChassisInBatch } },
            { 'answers.CHASSIS NUMBER': { $in: uniqueChassisInBatch } }
          ]
        };
        if (!form.parentFormId) {
          parentQuery.batchId = { $ne: batchId };
        }

        try {
          const matchedParents = await Response.find(parentQuery)
            .select('id _id chassisNumber answers createdAt status submittedBy')
            .sort({ createdAt: -1 })
            .lean();

          matchedParents.forEach(p => {
            const pAns = p.answers instanceof Map ? Object.fromEntries(p.answers) : (p.answers || {});
            const pChassis = (p.chassisNumber || extractChassisFromAns(pAns) || '').toLowerCase().trim();
            if (pChassis && !chassisToParentMap.has(pChassis)) {
              chassisToParentMap.set(pChassis, p.id || (p._id ? p._id.toString() : null));
            }
          });
          console.log(`[BATCH ${batchId}] Auto-matched ${chassisToParentMap.size} parent chassis records.`);
        } catch (matchErr) {
          console.warn('[BATCH IMPORT] Error prefetching parent responses for chassis matching:', matchErr);
        }
      }
    }

    const collectAllQuestions = (questions, result = []) => {
      if (!Array.isArray(questions)) return result;
      questions.forEach(q => {
        result.push(q);
        if (Array.isArray(q.followUpQuestions)) {
          collectAllQuestions(q.followUpQuestions, result);
        }
      });
      return result;
    };

    const allQuestions = [];
    if (form.sections) {
      form.sections.forEach(section => {
        if (section.questions) {
          collectAllQuestions(section.questions, allQuestions);
        }
      });
    }
    if (form.followUpQuestions) {
      collectAllQuestions(form.followUpQuestions, allQuestions);
    }

    const rankTrackedQuestions = allQuestions.filter(q => q.trackResponseRank || q.trackResponseQuestion);
    const rankMaps = {};
    for (const question of rankTrackedQuestions) {
      const qId = question.id;
      const trackingQId = `${qId}_tracking`;
      const counts = await Response.aggregate([
        {
          $match: {
            questionId: actualQuestionId,
            isSectionSubmit: { $ne: true },
            $or: [
              { [`answers.${qId}`]: { $exists: true, $ne: null } },
              { [`answers.${trackingQId}`]: { $exists: true, $ne: null } }
            ]
          }
        },
        {
          $project: {
            answerVal: { $ifNull: [`$answers.${qId}`, `$answers.${trackingQId}`] }
          }
        },
        {
          $group: {
            _id: "$answerVal",
            count: { $sum: 1 }
          }
        }
      ]);
      const map = new Map();
      counts.forEach(c => {
        const strVal = extractAnswerString(c._id);
        if (strVal !== '') {
          map.set(strVal.toLowerCase(), c.count);
        }
      });
      rankMaps[qId] = map;
    }

    // STEP 1: Collect ALL Google Drive URLs from ALL responses FIRST
    console.log(`[BATCH ${batchId}] Collecting all Google Drive URLs from ${responses.length} responses`);

    const allGoogleDriveUrls = [];
    const urlToResponseMap = new Map();

    responses.forEach((response, responseIndex) => {
      const { answers } = response;

      if (!answers || typeof answers !== 'object') return;

      Object.entries(answers).forEach(([questionId, answer]) => {
        if (!answer) return;

        if (typeof answer === 'string' && isGoogleDriveUrl(answer)) {
          const urlKey = `${responseIndex}_${questionId}`;
          allGoogleDriveUrls.push({
            url: answer,
            questionId,
            responseIndex,
            type: 'single'
          });
          urlToResponseMap.set(urlKey, answer);
        } else if (Array.isArray(answer)) {
          answer.forEach((item, itemIndex) => {
            if (typeof item === 'string' && isGoogleDriveUrl(item)) {
              const urlKey = `${responseIndex}_${questionId}_${itemIndex}`;
              allGoogleDriveUrls.push({
                url: item,
                questionId,
                responseIndex,
                arrayIndex: itemIndex,
                type: 'array'
              });
              urlToResponseMap.set(urlKey, item);
            }
          });
        }
      });
    });

    console.log(`[BATCH ${batchId}] Found ${allGoogleDriveUrls.length} Google Drive URLs to process`);

    // STEP 2: Process ALL images in BATCH using optimized service
    const createdResponses = [];
    const errors = [];

    if (allGoogleDriveUrls.length > 0) {
      try {
        // Emit initial progress
        emitImageProgress(batchId, {
          processed: 0,
          total: allGoogleDriveUrls.length,
          status: 'processing',
          message: `Starting batch processing of ${allGoogleDriveUrls.length} images...`
        });

        // Create a single answers object with ALL URLs for batch processing
        const batchAnswers = {};
        const urlMapping = {};

        allGoogleDriveUrls.forEach((item, index) => {
          const uniqueKey = `batch_${index}`;
          batchAnswers[uniqueKey] = item.url;
          urlMapping[uniqueKey] = item;
        });

        // Process ALL images at once with optimized function
        const onProgressCallback = (progress) => {
          emitImageProgress(batchId, {
            processed: progress.currentImage,
            total: progress.totalImages,
            status: progress.status,
            message: progress.message || `Processing images...`,
            percentage: progress.percentage
          });
        };

        // Prepare metadata for Google Drive folder structure
        const metadata = {
          tenantId: form.tenantId,
          formId: actualQuestionId,
          submissionId: `batch-${batchId}`,
          submissionTimestamp: Date.now()
        };

        const processedBatch = await processResponseImages(
          batchAnswers,
          metadata,  // CORRECT: This should be metadata object
          onProgressCallback,
          batchId
        );

        // Create mapping of original URL -> Cloudinary URL
        const processedUrlMap = new Map();
        const driveBackupMap = new Map();
        Object.entries(processedBatch.processedAnswers).forEach(([uniqueKey, cloudinaryUrl]) => {
          const item = urlMapping[uniqueKey];
          if (item && cloudinaryUrl !== item.url) {
            processedUrlMap.set(item.url, cloudinaryUrl);

            // Store drive backup info
            if (processedBatch.driveBackupUrls && processedBatch.driveBackupUrls[uniqueKey]) {
              driveBackupMap.set(item.url, processedBatch.driveBackupUrls[uniqueKey]);
            }
          }
        });
        console.log(`[BATCH ${batchId}] Successfully processed ${processedUrlMap.size}/${allGoogleDriveUrls.length} URLs`);

        // STEP 3: Process each response with already converted URLs
        const responsesToSave = [];
        for (let index = 0; index < responses.length; index++) {
          try {
            const { answers, submittedBy, submitterContact, parentResponseId, submittedAt } = responses[index];

            // Replace Google Drive URLs with Cloudinary URLs in this response
            const processedAnswers = {};
            Object.entries(answers).forEach(([questionId, answer]) => {
              if (!answer) {
                processedAnswers[questionId] = answer;
                return;
              }

              if (typeof answer === 'string' && isGoogleDriveUrl(answer)) {
                // Replace with processed URL if available
                processedAnswers[questionId] = processedUrlMap.get(answer) || answer;
              } else if (Array.isArray(answer)) {
                // Process array answers
                processedAnswers[questionId] = answer.map(item =>
                  (typeof item === 'string' && isGoogleDriveUrl(item))
                    ? (processedUrlMap.get(item) || item)
                    : item
                );
              } else {
                processedAnswers[questionId] = answer;
              }
            });

            let correct = 0;
            let total = 0;

            allQuestions.forEach(question => {
              if (question.type === 'yesNoNA') {
                total++;
                const answer = processedAnswers[question.id];
                if (answer && String(answer).toLowerCase() === 'yes') {
                  correct++;
                }
              }
            });
            // Calculate ranks for specific questions
            const responseRanks = {};
            for (const question of rankTrackedQuestions) {
              const qId = question.id;
              const trackingQId = `${qId}_tracking`;
              const rawAns = processedAnswers[qId] !== undefined ? processedAnswers[qId] : processedAnswers[trackingQId];
              const answerStr = extractAnswerString(rawAns);
              if (answerStr !== '') {
                const answerKey = answerStr.toLowerCase();
                const map = rankMaps[qId] || new Map();
                const count = map.get(answerKey) || 0;
                const newRank = count + 1;
                responseRanks[qId] = newRank;
                map.set(answerKey, newRank);
              }
            }

            const chassisVal = extractChassisFromAns(processedAnswers) || (responses[index]?.chassisNumber ? String(responses[index].chassisNumber).trim() : undefined);
            let resolvedParentResponseId = parentResponseId;
            if (!resolvedParentResponseId && chassisVal) {
              resolvedParentResponseId = chassisToParentMap.get(chassisVal.toLowerCase().trim()) || undefined;
            }

            const rawDateVal =
              responses[index]?.submittedAt ||
              responses[index]?.createdAt ||
              responses[index]?.timestamp ||
              processedAnswers["submittedAt"] ||
              processedAnswers["Submitted Date *"] ||
              processedAnswers["Submitted Date"] ||
              processedAnswers["submitted date"] ||
              processedAnswers["submittedDate"] ||
              processedAnswers["Timestamp"] ||
              processedAnswers["timestamp"] ||
              processedAnswers["Date"] ||
              processedAnswers["date"] ||
              processedAnswers["Inspection Date"] ||
              processedAnswers["Created At"] ||
              processedAnswers["createdAt"];

            const rowSubmittedAt = parseExcelDateBackend(rawDateVal) || new Date();

            const isDispVal = String(responses[index]?.isDispatched || processedAnswers["Dispatched"] || processedAnswers["dispatched"] || "").toLowerCase().trim();
            const isDispatched = isDispVal === "yes" || isDispVal === "true" || responses[index]?.isDispatched === true;
            const rawDispAt = responses[index]?.dispatchedAt || processedAnswers["Dispatched At"] || processedAnswers["dispatchedAt"] || processedAnswers["dispatched at"];
            const rowDispatchedAt = isDispatched ? (parseExcelDateBackend(rawDispAt) || rowSubmittedAt) : undefined;

            const rawStatusVal = responses[index]?.status || processedAnswers["Status"] || processedAnswers["status"];
            const rowStatus = rawStatusVal ? String(rawStatusVal).trim() : 'pending';

            // Clean up virtual columns so they don't pollute question answers
            const formQuestionIds = new Set(allQuestions.map(q => q.id || (q._id ? q._id.toString() : null)).filter(Boolean));
            ["Timestamp", "timestamp", "Date", "date", "Status", "status", "Dispatched", "dispatched", "Dispatched At", "dispatched at", "submittedAt", "isDispatched", "dispatchedAt", "Submitted Date", "Submitted Date *", "submitted date", "submittedDate"].forEach(k => {
              if (!formQuestionIds.has(k)) {
                delete processedAnswers[k];
              }
            });

            const rowSubmissionMetadata = {
              ...(submissionMetadata || {}),
              submittedAt: rowSubmittedAt,
              capturedLocation: submissionMetadata?.capturedLocation
                ? {
                    ...submissionMetadata.capturedLocation,
                    capturedAt: rowSubmittedAt
                  }
                : undefined
            };

            const responseData = {
              id: uuidv4(),
              questionId: actualQuestionId,
              answers: new Map(Object.entries(processedAnswers)),
              responseRanks: new Map(Object.entries(responseRanks)),
              parentResponseId: resolvedParentResponseId || undefined,
              batchId: batchId,
              chassisNumber: chassisVal || undefined,
              submittedBy: submittedBy || 'Excel Import',
              submitterContact,
              submissionMetadata: rowSubmissionMetadata,
              status: rowStatus,
              isDispatched: isDispatched,
              dispatchedAt: rowDispatchedAt,
              tenantId: form.tenantId,
              score: { correct, total },
              createdBy:
                submittedBy && submittedBy !== 'Excel Import'
                  ? null
                  : req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)
                    ? req.user._id
                    : null,
              submittedAt: rowSubmittedAt,
              createdAt: rowSubmittedAt
            };

            const response = new Response(responseData);
            responsesToSave.push(response);
          } catch (error) {
            console.error(`[BATCH ${batchId}] Response prep error (index ${index}):`, error.message);
            errors.push({
              index,
              submittedBy: responses[index]?.submittedBy || 'Unknown',
              error: error.message
            });
          }
        }

        // Save responses in fast bulk chunks (250 at a time)
        const batchSize = 250;
        for (let i = 0; i < responsesToSave.length; i += batchSize) {
          const chunk = responsesToSave.slice(i, i + batchSize);
          try {
            const inserted = await Response.insertMany(chunk, { ordered: false });
            inserted.forEach((doc) => {
              createdResponses.push({
                id: doc.id,
                submittedBy: doc.submittedBy,
                chassisNumber: doc.chassisNumber,
                parentResponseId: doc.parentResponseId,
                status: 'success'
              });
            });
          } catch (error) {
            if (error.insertedDocs && error.insertedDocs.length > 0) {
              error.insertedDocs.forEach((doc) => {
                createdResponses.push({
                  id: doc.id,
                  submittedBy: doc.submittedBy,
                  chassisNumber: doc.chassisNumber,
                  parentResponseId: doc.parentResponseId,
                  status: 'success'
                });
              });
            }
            if (error.writeErrors && error.writeErrors.length > 0) {
              error.writeErrors.forEach((we) => {
                errors.push({
                  submittedBy: 'Import row',
                  error: we.errmsg || we.message
                });
              });
            } else {
              console.error(`[BATCH ${batchId}] Bulk save error, attempting individual fallback:`, error.message);
              await Promise.all(chunk.map(async (response) => {
                try {
                  if (response.submittedAt) {
                    await response.save({ timestamps: false });
                  } else {
                    await response.save();
                  }
                  createdResponses.push({
                    id: response.id,
                    submittedBy: response.submittedBy,
                    chassisNumber: response.chassisNumber,
                    parentResponseId: response.parentResponseId,
                    status: 'success'
                  });
                } catch (singleErr) {
                  errors.push({
                    submittedBy: response.submittedBy,
                    error: singleErr.message
                  });
                }
              }));
            }
          }
        }

        // Notify form rooms and dashboards immediately
        if (typeof emitBatchImported === 'function') {
          const batchInfo = {
            batchId,
            count: createdResponses.length,
            total: responses.length,
            formId: actualQuestionId,
          };
          emitBatchImported(actualQuestionId, batchInfo);
          if (form?.id && String(form.id) !== String(actualQuestionId)) {
            emitBatchImported(form.id, batchInfo);
          }
          if (form?._id && String(form._id) !== String(actualQuestionId)) {
            emitBatchImported(String(form._id), batchInfo);
          }
        }

        // Emit completion progress
        emitImageProgress(batchId, {
          processed: allGoogleDriveUrls.length,
          total: allGoogleDriveUrls.length,
          status: 'complete',
          message: `✓ Batch processing complete: ${createdResponses.length}/${responses.length} responses saved`
        });

      } catch (error) {
        console.error(`[BATCH ${batchId}] Batch processing error:`, error);
        errors.push({
          index: 'batch',
          submittedBy: 'batch',
          error: error.message
        });
      }

        const extractedChassis = [];
        for (const resp of responses) {
          if (resp?.answers) {
            for (const [k, v] of Object.entries(resp.answers)) {
              if (
                typeof v === 'string' &&
                v.trim() &&
                (k.toLowerCase().includes('chassis') || k.toLowerCase().includes('vin') || k.toLowerCase().includes('id number') || k === 'chassis_number')
              ) {
                if (!extractedChassis.includes(v.trim())) {
                  extractedChassis.push(v.trim());
                }
                if (extractedChassis.length >= 25) break;
              }
            }
          }
          if (extractedChassis.length >= 25) break;
        }

        recordImportHistory({
          tenantId: form.tenantId || req.user?.tenantId,
          userId: req.user?._id,
          userName: req.user?.username || req.user?.name || req.user?.email || 'Admin',
          userEmail: req.user?.email || '',
          userRole: req.user?.role || 'admin',
          actionType: 'BULK_RESPONSE_IMPORT',
          actionTitle: 'Bulk Response Import',
          formId: actualQuestionId,
          formTitle: form.title || 'Imported Form',
          batchId,
          fileName: req.body.fileName || 'Response_Template.xlsx',
          templateType: batchId.includes('-t2') ? 'Template 2' : batchId.includes('-fu-') ? 'Follow-up Form' : 'Main Form',
          dataCount: {
            total: responses.length,
            success: createdResponses.length,
            failed: errors.length
          },
          details: {
            chassisNumbers: extractedChassis,
            submitters: Array.from(new Set(responses.map(r => r.submittedBy).filter(Boolean))),
            questionsCount: Object.keys(responses[0]?.answers || {}).length,
            errors: errors.slice(0, 10),
            notes: `Imported ${createdResponses.length} of ${responses.length} responses (with images)`
          },
          status: errors.length === 0 ? 'success' : createdResponses.length > 0 ? 'partial' : 'failed'
        }).catch(err => console.error('[IMPORT HISTORY LOG ERROR]', err));

      // SEND RESPONSE FOR IMAGES PATH
      console.log(`[BATCH ${batchId}] Sending success response (with images)`);
      return res.status(201).json({
        success: true,
        message: `Batch import completed: ${createdResponses.length} responses imported successfully`,
        data: {
          imported: createdResponses.length,
          total: responses.length,
          failed: errors.length,
          createdResponses,
          imageConversion: {
            total: allGoogleDriveUrls.length,
            converted: allGoogleDriveUrls.length,
            status: allGoogleDriveUrls.length > 0 ? "completed" : "not_required",
            batchId
          },
          errors: errors.length > 0 ? errors : undefined
        }
      });

    } else {
      // No images to process, just save responses directly
      console.log(`[BATCH ${batchId}] No images to process, saving ${responses.length} responses directly`);

      const createdResponses = [];
      const errors = [];
      const responsesToSave = [];

      for (let index = 0; index < responses.length; index++) {
        try {
          const { answers, submittedBy, submitterContact, parentResponseId, submittedAt } = responses[index];

          // Process answers (convert to proper format)
          const processedAnswers = {};
          if (answers && typeof answers === 'object') {
            Object.entries(answers).forEach(([questionId, answer]) => {
              processedAnswers[questionId] = answer;
            });
          }

          // Calculate score for yesNoNA questions
          let correct = 0;
          let total = 0;
          allQuestions.forEach(question => {
            if (question.type === 'yesNoNA') {
              total++;
              const answer = processedAnswers[question.id];
              if (answer && String(answer).toLowerCase() === 'yes') {
                correct++;
              }
            }
          });

          // Calculate ranks for specific questions
          const responseRanks = {};
          for (const question of rankTrackedQuestions) {
            const qId = question.id;
            const trackingQId = `${qId}_tracking`;
            const rawAns = processedAnswers[qId] !== undefined ? processedAnswers[qId] : processedAnswers[trackingQId];
            const answerStr = extractAnswerString(rawAns);
            if (answerStr !== '') {
              const answerKey = answerStr.toLowerCase();
              const map = rankMaps[qId] || new Map();
              const count = map.get(answerKey) || 0;
              const newRank = count + 1;
              responseRanks[qId] = newRank;
              map.set(answerKey, newRank);
            }
          }

          const chassisVal = extractChassisFromAns(processedAnswers) || (responses[index]?.chassisNumber ? String(responses[index].chassisNumber).trim() : undefined);
          let resolvedParentResponseId = parentResponseId;
          if (!resolvedParentResponseId && chassisVal) {
            resolvedParentResponseId = chassisToParentMap.get(chassisVal.toLowerCase().trim()) || undefined;
          }

          const rawDateVal =
            responses[index]?.submittedAt ||
            responses[index]?.createdAt ||
            responses[index]?.timestamp ||
            processedAnswers["submittedAt"] ||
            processedAnswers["Submitted Date *"] ||
            processedAnswers["Submitted Date"] ||
            processedAnswers["submitted date"] ||
            processedAnswers["submittedDate"] ||
            processedAnswers["Timestamp"] ||
            processedAnswers["timestamp"] ||
            processedAnswers["Date"] ||
            processedAnswers["date"] ||
            processedAnswers["Inspection Date"] ||
            processedAnswers["Created At"] ||
            processedAnswers["createdAt"];

          const rowSubmittedAt = parseExcelDateBackend(rawDateVal) || new Date();

          const isDispVal = String(responses[index]?.isDispatched || processedAnswers["Dispatched"] || processedAnswers["dispatched"] || "").toLowerCase().trim();
          const isDispatched = isDispVal === "yes" || isDispVal === "true" || responses[index]?.isDispatched === true;
          const rawDispAt = responses[index]?.dispatchedAt || processedAnswers["Dispatched At"] || processedAnswers["dispatchedAt"] || processedAnswers["dispatched at"];
          const rowDispatchedAt = isDispatched ? (parseExcelDateBackend(rawDispAt) || rowSubmittedAt) : undefined;

          const rawStatusVal = responses[index]?.status || processedAnswers["Status"] || processedAnswers["status"];
          const rowStatus = rawStatusVal ? String(rawStatusVal).trim() : 'pending';

          // Clean up virtual columns so they don't pollute question answers
          const formQuestionIds = new Set(allQuestions.map(q => q.id || (q._id ? q._id.toString() : null)).filter(Boolean));
          ["Timestamp", "timestamp", "Date", "date", "Status", "status", "Dispatched", "dispatched", "Dispatched At", "dispatched at", "submittedAt", "isDispatched", "dispatchedAt", "Submitted Date", "Submitted Date *", "submitted date", "submittedDate"].forEach(k => {
            if (!formQuestionIds.has(k)) {
              delete processedAnswers[k];
            }
          });

          const rowSubmissionMetadata = {
            ...(submissionMetadata || {}),
            submittedAt: rowSubmittedAt,
            capturedLocation: submissionMetadata?.capturedLocation
              ? {
                  ...submissionMetadata.capturedLocation,
                  capturedAt: rowSubmittedAt
                }
              : undefined
          };

          // Create response data
          const responseData = {
            id: uuidv4(),
            questionId: actualQuestionId,
            answers: new Map(Object.entries(processedAnswers)),
            responseRanks: new Map(Object.entries(responseRanks)),
            parentResponseId: resolvedParentResponseId || undefined,
            batchId: batchId,
            chassisNumber: chassisVal || undefined,
            submittedBy: submittedBy || 'Excel Import',
            submitterContact,
            submissionMetadata: rowSubmissionMetadata,
            status: rowStatus,
            isDispatched: isDispatched,
            dispatchedAt: rowDispatchedAt,
            tenantId: form.tenantId,
            score: { correct, total },
            createdBy:
              req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)
                ? req.user._id
                : null,
            submittedAt: rowSubmittedAt,
            createdAt: rowSubmittedAt
          };

          // Prepare Mongoose document
          const response = new Response(responseData);
          responsesToSave.push(response);
        } catch (error) {
          console.error(`[BATCH ${batchId}] Response prep error (no images, index ${index}):`, error.message);
          errors.push({
            index,
            submittedBy: responses[index]?.submittedBy || 'Unknown',
            error: error.message
          });
        }
      }

      // Save in fast bulk chunks (250 at a time)
      const batchSize = 250;
      for (let i = 0; i < responsesToSave.length; i += batchSize) {
        const chunk = responsesToSave.slice(i, i + batchSize);
        try {
          const inserted = await Response.insertMany(chunk, { ordered: false });
          inserted.forEach((doc) => {
            createdResponses.push({
              id: doc.id,
              submittedBy: doc.submittedBy,
              chassisNumber: doc.chassisNumber,
              parentResponseId: doc.parentResponseId,
              status: 'success'
            });
          });
        } catch (error) {
          if (error.insertedDocs && error.insertedDocs.length > 0) {
            error.insertedDocs.forEach((doc) => {
              createdResponses.push({
                id: doc.id,
                submittedBy: doc.submittedBy,
                chassisNumber: doc.chassisNumber,
                parentResponseId: doc.parentResponseId,
                status: 'success'
              });
            });
          }
          if (error.writeErrors && error.writeErrors.length > 0) {
            error.writeErrors.forEach((we) => {
              errors.push({
                submittedBy: 'Import row',
                error: we.errmsg || we.message
              });
            });
          } else {
            console.error(`[BATCH ${batchId}] Bulk save error (no images), attempting individual fallback:`, error.message);
            await Promise.all(chunk.map(async (response) => {
              try {
                if (response.submittedAt) {
                  await response.save({ timestamps: false });
                } else {
                  await response.save();
                }
                createdResponses.push({
                  id: response.id,
                  submittedBy: response.submittedBy,
                  chassisNumber: response.chassisNumber,
                  parentResponseId: response.parentResponseId,
                  status: 'success'
                });
              } catch (singleErr) {
                errors.push({
                  submittedBy: response.submittedBy,
                  error: singleErr.message
                });
              }
            }));
          }
        }
      }

      // Notify form rooms and dashboards immediately
      if (typeof emitBatchImported === 'function') {
        const batchInfo = {
          batchId,
          count: createdResponses.length,
          total: responses.length,
          formId: actualQuestionId,
        };
        emitBatchImported(actualQuestionId, batchInfo);
        if (form?.id && String(form.id) !== String(actualQuestionId)) {
          emitBatchImported(form.id, batchInfo);
        }
        if (form?._id && String(form._id) !== String(actualQuestionId)) {
          emitBatchImported(String(form._id), batchInfo);
        }
      }

      // Extract sample chassis numbers
      const extractedChassis = [];
      for (const resp of responses) {
        if (resp?.answers) {
          for (const [k, v] of Object.entries(resp.answers)) {
            if (
              typeof v === 'string' &&
              v.trim() &&
              (k.toLowerCase().includes('chassis') || k.toLowerCase().includes('vin') || k.toLowerCase().includes('id number') || k === 'chassis_number')
            ) {
              if (!extractedChassis.includes(v.trim())) {
                extractedChassis.push(v.trim());
              }
              if (extractedChassis.length >= 25) break;
            }
          }
        }
        if (extractedChassis.length >= 25) break;
      }

      recordImportHistory({
        tenantId: form.tenantId || req.user?.tenantId,
        userId: req.user?._id,
        userName: req.user?.username || req.user?.name || req.user?.email || 'Admin',
        userEmail: req.user?.email || '',
        userRole: req.user?.role || 'admin',
        actionType: 'BULK_RESPONSE_IMPORT',
        actionTitle: 'Bulk Response Import',
        formId: actualQuestionId,
        formTitle: form.title || 'Imported Form',
        batchId,
        fileName: req.body.fileName || 'Response_Template.xlsx',
        templateType: batchId.includes('-t2') ? 'Template 2' : batchId.includes('-fu-') ? 'Follow-up Form' : 'Main Form',
        dataCount: {
          total: responses.length,
          success: createdResponses.length,
          failed: errors.length
        },
        details: {
          chassisNumbers: extractedChassis,
          submitters: Array.from(new Set(responses.map(r => r.submittedBy).filter(Boolean))),
          questionsCount: Object.keys(responses[0]?.answers || {}).length,
          errors: errors.slice(0, 10),
          notes: `Imported ${createdResponses.length} of ${responses.length} responses`
        },
        status: errors.length === 0 ? 'success' : createdResponses.length > 0 ? 'partial' : 'failed'
      }).catch(err => console.error('[IMPORT HISTORY LOG ERROR]', err));

      // Send success response
      console.log(`[BATCH ${batchId}] Sending success response (no images)`);
      return res.status(201).json({
        success: true,
        message: `Batch import completed: ${createdResponses.length} responses imported successfully`,
        data: {
          imported: createdResponses.length,
          total: responses.length,
          failed: errors.length,
          createdResponses,
          errors: errors.length > 0 ? errors : undefined
        }
      });
    }

  } catch (error) {
    console.error('Batch import error:', error);
    return res.status(500).json({
      success: false,
      message: `Internal server error during batch import: ${error?.message || 'unknown error'}`,
      error: error?.message,
    });
  }
};
/**
 * Get current rank for a specific question and answer
 * Used for real-time ranking display during form filling
 */

export const getRank = async (req, res) => {
  try {
    const { formId, questionId, answer } = req.query;
    const { tenantSlug } = req.params;

    if (!formId || !questionId || answer === undefined) {
      return res.status(400).json({
        success: false,
        message: 'formId, questionId, and answer are required'
      });
    }

    let tenantId;
    if (tenantSlug) {
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });
      if (tenant) {
        tenantId = tenant._id;
      }
    }

    // Find the form to verify it exists and if tracking is enabled
    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) {
      form = await Form.findById(formId);
    }
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found',
      });
    }

    // Find the specific question to check for tracking configuration
    let trackingQId = questionId;
    const findQuestion = (questions) => {
      if (!questions || !Array.isArray(questions)) return null;
      for (const q of questions) {
        if (q.id === questionId || q._id?.toString() === questionId) return q;
        if (q.followUpQuestions && q.followUpQuestions.length > 0) {
          const found = findQuestion(q.followUpQuestions);
          if (found) return found;
        }
      }
      return null;
    };

    let question = findQuestion(form.followUpQuestions || []);
    if (!question && form.sections && Array.isArray(form.sections)) {
      for (const section of form.sections) {
        question = findQuestion(section.questions || []);
        if (question) break;
      }
    }

    if (
      question &&
      (question.trackResponseQuestion === true ||
        question.trackResponseQuestion === "true")
    ) {
      trackingQId = `${questionId}_tracking`;
    }

    const strAnswer = extractAnswerString(answer);
    if (!strAnswer) {
      return res.status(200).json({
        success: true,
        data: { rank: 1 }
      });
    }

    // Count existing final responses with the EXACT SAME answer for THIS form alone (isolated rank tracking)
    const formIds = getThisFormIds(form, formId);
    const extraQIds = getThisFormExtraQuestionIds(form);

    const orConditions = buildChassisOrConditions(questionId, trackingQId, strAnswer, extraQIds);

    const query = {
      $or: [
        { questionId: { $in: formIds } },
        { formId: { $in: formIds } }
      ],
      $and: [
        { $or: orConditions }
      ],
      isSectionSubmit: { $ne: true }
    };

    const matchingResponses = await Response.find(query)
      .select('id _id status answers createdAt isDispatched dispatchedAt dispatchedByName biwReview submittedBy createdBy')
      .lean();

    const sortedResponses = matchingResponses.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let reworkCount = 0;
    let hasBeenReworked = false;

    const history = sortedResponses.map((resp, index) => {
      const answersMap = resp.answers instanceof Map ? Object.fromEntries(resp.answers) : (resp.answers || {});
      let hasRework = false;
      let hasReject = false;
      for (const val of Object.values(answersMap)) {
        if (val && typeof val === 'object' && val.status) {
          const s = String(val.status).toLowerCase().trim();
          if (s === 'rework' || s.includes('rework')) hasRework = true;
          if (s === 'rejected' || s === 'reject') hasReject = true;
        } else if (typeof val === 'string') {
          const s = val.toLowerCase().trim();
          if (s === 'rework' || s.includes('rework')) hasRework = true;
          if (s === 'rejected' || s === 'reject') hasReject = true;
        }
      }

      let status = 'Direct Ok';
      if (hasReject) {
        status = 'Rejected';
      } else if (hasRework) {
        reworkCount++;
        hasBeenReworked = true;
        status = `Rework ${reworkCount}`;
      } else if (index > 0 || hasBeenReworked) {
        status = 'Rework Accepted';
      } else {
        status = 'Direct Ok';
      }

      return {
        rank: index + 1,
        status: resp.status && resp.status !== 'pending' ? resp.status : status,
        id: resp.id || resp._id,
        createdAt: resp.createdAt,
        submittedBy: resp.submittedBy || resp.createdBy || null,
        isDispatched: resp.isDispatched || false,
        dispatchedAt: resp.dispatchedAt || null,
        dispatchedByName: resp.dispatchedByName || null,
        biwReview: resp.biwReview || null
      };
    });

    const count = sortedResponses.length;
    const lastResponse = count > 0 ? sortedResponses[count - 1] : null;
    const previousStatus = history.length > 0 ? history[history.length - 1].status : (lastResponse ? lastResponse.status : null);

    const responseIds = sortedResponses.map(r => String(r.id || r._id));
    let chatCount = 0;
    try {
      if (responseIds.length > 0) {
        chatCount = await ChatMessage.countDocuments({
          responseId: { $in: responseIds }
        });
      }
    } catch (e) {
      console.warn('Chat count query skipped:', e.message);
    }

    const isAnyDispatched = sortedResponses.some(r => r.isDispatched);
    const lastDispatched = [...sortedResponses].reverse().find(r => r.isDispatched);
    const lastBiwReviewed = [...sortedResponses].reverse().find(r => r.biwReview && r.biwReview.status);

    // Determine parent/child relationship and compute follow-up badge info
    let parentForm = null;
    if (form.parentFormId) {
      parentForm = await Form.findOne({
        $or: [
          { id: form.parentFormId },
          ...(mongoose.Types.ObjectId.isValid(form.parentFormId) ? [{ _id: form.parentFormId }] : [])
        ]
      }).select('id _id title childForms').lean();
    }
    if (!parentForm) {
      parentForm = await Form.findOne({
        'childForms.formId': { $in: [form.id, form._id?.toString(), formId] }
      }).select('id _id title childForms').lean();
    }

    const isChildForm = Boolean(form.parentFormId || parentForm);
    const isParentForm = Boolean(form.childForms && form.childForms.length > 0);

    let followUpBadge = null;
    if (matchingResponses.length > 0) {
      const firstRespDate = new Date(sortedResponses[0].createdAt);
      const daysElapsed = Math.max(0, Math.floor((Date.now() - firstRespDate.getTime()) / (1000 * 60 * 60 * 24)));

      let badgeColor = 'green';
      let badgeText = `Linked (${count} ${count === 1 ? 'Attempt' : 'Attempts'})`;
      let statusLabel = 'Follow-up Linked';

      if (isChildForm && parentForm) {
        badgeColor = 'green';
        badgeText = `Parent Form: ${parentForm.title} (Attempt #${count})`;
        statusLabel = 'Parent Record Linked';
      } else if (isParentForm) {
        if (daysElapsed <= 10) {
          badgeColor = 'white';
          badgeText = `Pending (${daysElapsed}d / 10d)`;
          statusLabel = 'Pending Window';
        } else {
          badgeColor = 'red';
          badgeText = `Overdue (${daysElapsed}d)`;
          statusLabel = 'Follow-up Overdue';
        }
      }

      followUpBadge = {
        exists: true,
        isParentLinked: Boolean(parentForm),
        parentFormTitle: parentForm?.title || null,
        parentFormId: parentForm?.id || parentForm?._id?.toString() || null,
        attemptsCount: count,
        lastStatus: previousStatus,
        lastSubmittedBy: lastResponse ? (lastResponse.submittedBy || lastResponse.createdBy || null) : null,
        lastCreatedAt: lastResponse ? lastResponse.createdAt : null,
        daysElapsed: daysElapsed,
        color: badgeColor,
        badgeText: badgeText,
        statusLabel: statusLabel,
        history: history
      };
    } else {
      if (isChildForm) {
        followUpBadge = {
          exists: false,
          isParentLinked: false,
          parentFormTitle: parentForm?.title || null,
          parentFormId: parentForm?.id || parentForm?._id?.toString() || null,
          attemptsCount: 0,
          color: 'orange',
          badgeText: 'New Chassis (No Parent Record Found)',
          statusLabel: 'Child Only'
        };
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        rank: count + 1,
        count: count,
        history: history,
        previousStatus: previousStatus,
        lastResponseId: lastResponse ? (lastResponse.id || lastResponse._id) : null,
        isDispatched: isAnyDispatched,
        dispatchedAt: lastDispatched ? lastDispatched.dispatchedAt : null,
        dispatchedByName: lastDispatched ? lastDispatched.dispatchedByName : null,
        biwReview: lastBiwReviewed ? lastBiwReviewed.biwReview : null,
        chatCount: chatCount,
        lastSubmittedBy: lastResponse ? (lastResponse.submittedBy || lastResponse.createdBy || null) : null,
        parentMatch: followUpBadge,
        followUpStatus: followUpBadge
      }
    });

  } catch (error) {
    console.error('Get rank error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};


// High-performance in-memory cache for instant suggestions (<1ms)
const suggestionsMemoryCache = new Map(); // key -> { data, expiresAt }
const formMetaCache = new Map(); // formId -> { form, expiresAt }
const tenantSlugCache = new Map(); // slug -> { tenantId, expiresAt }

/**
 * Get suggested answers based on a single question-answer pair.
 * This is used to auto-fill or suggest previous answers when a user starts filling a form.
 */
export const getSuggestedAnswers = async (req, res) => {
  const startTime = Date.now();
  try {
    const { formId: queryFormId, questionId, answer } = req.query;
    const { tenantSlug, formId: paramFormId } = req.params;

    const formId = paramFormId || queryFormId;

    if (!formId || !questionId || answer === undefined) {
      return res.status(400).json({
        success: false,
        message: 'formId, questionId, and answer are required'
      });
    }

    const strAnswer = extractAnswerString(answer);
    if (!strAnswer) {
      return res.status(200).json({
        success: true,
        data: { suggestedAnswers: null }
      });
    }

    // ⚡ INSTANT IN-MEMORY CACHE HIT: Return in <1ms without DB trip!
    const cacheKey = `${formId}:${questionId}:${strAnswer.toLowerCase().trim()}:${tenantSlug || ''}`;
    const cachedEntry = suggestionsMemoryCache.get(cacheKey);
    if (cachedEntry && Date.now() < cachedEntry.expiresAt) {
      return res.status(200).json({
        success: true,
        data: { suggestedAnswers: cachedEntry.data }
      });
    }

    let tenantId;
    if (tenantSlug) {
      const cachedT = tenantSlugCache.get(tenantSlug);
      if (cachedT && Date.now() < cachedT.expiresAt) {
        tenantId = cachedT.tenantId;
      } else {
        const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true }).select('_id').lean();
        if (tenant) {
          tenantId = tenant._id;
          tenantSlugCache.set(tenantSlug, { tenantId, expiresAt: Date.now() + 10 * 60 * 1000 });
        }
      }
    }

    // ⚡ Fast Form Lookup with In-Memory Cache
    let form;
    const cachedF = formMetaCache.get(String(formId));
    if (cachedF && Date.now() < cachedF.expiresAt) {
      form = cachedF.form;
    } else {
      const isObjectId = mongoose.Types.ObjectId.isValid(formId);
      const formSearchQuery = isObjectId
        ? { $or: [{ id: formId }, { _id: new mongoose.Types.ObjectId(formId) }] }
        : { id: formId };

      form = await Form.findOne(formSearchQuery)
        .select('id _id title sections followUpQuestions childForms parentFormId tenantId')
        .lean();

      if (form) {
        if (formMetaCache.size > 200) formMetaCache.clear();
        formMetaCache.set(String(formId), { form, expiresAt: Date.now() + 5 * 60 * 1000 });
      }
    }

    if (!form) {
      console.warn(`[SUGGESTIONS] Form not found: ${formId}`);
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Find the specific question to check for tracking configuration
    let trackingQId = questionId;
    const findQuestion = (questions) => {
      if (!questions || !Array.isArray(questions)) return null;
      for (const q of questions) {
        if (q.id === questionId || q._id?.toString() === questionId) return q;
        if (q.followUpQuestions && q.followUpQuestions.length > 0) {
          const found = findQuestion(q.followUpQuestions);
          if (found) return found;
        }
      }
      return null;
    };

    let question = findQuestion(form.followUpQuestions || []);
    if (!question && form.sections && Array.isArray(form.sections)) {
      for (const section of form.sections) {
        question = findQuestion(section.questions || []);
        if (question) break;
      }
    }

    if (
      question &&
      (question.trackResponseQuestion === true ||
        question.trackResponseQuestion === "true")
    ) {
      trackingQId = `${questionId}_tracking`;
    }


    // Get previous responses for THIS form alone (isolated suggestion tracking)
    const formIds = getThisFormIds(form, formId);
    const extraQIds = getThisFormExtraQuestionIds(form);

    const orConditions = buildChassisOrConditions(questionId, trackingQId, strAnswer, extraQIds);

    const query = {
      $or: [
        { questionId: { $in: formIds } },
        { formId: { $in: formIds } }
      ],
      $and: [
        { $or: orConditions }
      ],
      isSectionSubmit: { $ne: true }
    };

    const matchingResponses = await Response.find(query)
      .select('answers responseRanks createdAt submittedAt status isSectionSubmit questionId _id id')
      .sort({ isSectionSubmit: 1, createdAt: 1 })
      .limit(10)
      .lean();

    if (matchingResponses.length === 0) {
      return res.status(200).json({
        success: true,
        data: { suggestedAnswers: null }
      });
    }

    // Sort matching responses: priority to non-partial, then by creation date (oldest first for ranking #1, #2, etc)
    const sortedResponses = matchingResponses.sort((a, b) => {
      if (a.isSectionSubmit !== b.isSectionSubmit) {
        return a.isSectionSubmit ? 1 : -1;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    let reworkCount = 0;
    let hasBeenReworked = false;

    const suggestions = sortedResponses.map((resp, index) => {
      let answersObj = resp.answers || {};
      if (answersObj instanceof Map) {
        answersObj = Object.fromEntries(answersObj);
      }

      let hasRework = false;
      let hasReject = false;
      for (const val of Object.values(answersObj)) {
        if (val && typeof val === 'object' && val.status) {
          const s = String(val.status).toLowerCase().trim();
          if (s === 'rework' || s.includes('rework')) hasRework = true;
          if (s === 'rejected' || s === 'reject') hasReject = true;
        } else if (typeof val === 'string') {
          const s = val.toLowerCase().trim();
          if (s === 'rework' || s.includes('rework')) hasRework = true;
          if (s === 'rejected' || s === 'reject') hasReject = true;
        }
      }

      let status = 'Direct Ok';
      if (hasReject) {
        status = 'Rejected';
      } else if (hasRework) {
        reworkCount++;
        hasBeenReworked = true;
        status = `Rework ${reworkCount}`;
      } else if (index > 0 || hasBeenReworked) {
        status = 'Rework Accepted';
      } else {
        status = 'Direct Ok';
      }

      return {
        rank: index + 1,
        status: resp.status && resp.status !== 'pending' ? resp.status : status,
        answers: answersObj,
        timestamp: resp.createdAt,
        id: resp.id || resp._id,
        attemptId: (resp._id || resp.id).toString(),
        chassisNumber: strAnswer || resp.chassisNumber || 'UNKNOWN',
        submittedBy: resp.submittedByName || resp.submittedBy || 'Inspector',
        submittedAt: resp.createdAt ? new Date(resp.createdAt).toISOString() : new Date().toISOString()
      };
    });

    if (suggestionsMemoryCache.size > 2000) suggestionsMemoryCache.clear();
    suggestionsMemoryCache.set(cacheKey, { data: suggestions, expiresAt: Date.now() + 60000 });

    return res.status(200).json({
      success: true,
      data: { suggestedAnswers: suggestions }
    });

  } catch (error) {
    console.error('[SUGGESTIONS] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch suggested answers'
    });
  }
};

/**
 * GET /api/responses/attempts/:formId?since=<ISO>
 * Returns prior attempts for every chassis on this form (or delta since a timestamp).
 * Used to hydrate mobile cached_attempts.
 */
export const getFormAttempts = async (req, res) => {
  try {
    const { formId } = req.params;
    const { since } = req.query;

    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required' });
    }

    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) {
      form = await Form.findById(formId);
    }
    const formIds = form ? getThisFormIds(form, formId) : [formId];

    const query = {
      $or: [
        { questionId: { $in: formIds } },
        { formId: { $in: formIds } }
      ]
    };

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        query.createdAt = { $gte: sinceDate };
      }
    }

    const responses = await Response.find(query)
      .sort({ createdAt: 1 })
      .lean();

    const chassisAttemptsMap = new Map();

    const attempts = responses.map((resp) => {
      let answersObj = resp.answers || {};
      if (answersObj instanceof Map) {
        answersObj = Object.fromEntries(answersObj);
      }

      let chassis = resp.chassisNumber || 
                    answersObj.chassis_number || 
                    answersObj.chassisNumber ||
                    answersObj['Identification Number'] ||
                    answersObj.identification_number ||
                    answersObj.identificationNumber ||
                    answersObj.identification ||
                    answersObj.Identification ||
                    answersObj['ID number'] ||
                    answersObj['ID Number'] ||
                    answersObj.id_number ||
                    answersObj.idNumber;

      if (!chassis) {
        for (const [k, v] of Object.entries(answersObj)) {
          if (v && typeof v === 'object' && (v.chassisNumber || v.value)) {
            chassis = v.chassisNumber || v.value;
            break;
          }
          const kLow = k.toLowerCase();
          if ((kLow.includes('identification') || kLow.includes('chassis') || kLow.includes('vin')) && typeof v === 'string' && v.trim().length >= 1) {
            chassis = v.trim();
            break;
          }
        }
      }
      chassis = chassis ? String(chassis).trim() : 'UNKNOWN';

      const currentCount = chassisAttemptsMap.get(chassis) || 0;
      const rank = resp.rank || (currentCount + 1);
      chassisAttemptsMap.set(chassis, Math.max(currentCount + 1, rank));

      let status = resp.subStatus || resp.status || 'Accepted';
      // Normalize status to Accepted / Rework / Rejected
      if (String(status).toLowerCase().includes('rework')) status = 'Rework';
      else if (String(status).toLowerCase().includes('reject')) status = 'Rejected';
      else status = 'Accepted';

      return {
        attemptId: (resp._id || resp.id).toString(),
        chassisNumber: chassis,
        rank: rank,
        status: status,
        answers: answersObj,
        submittedBy: resp.submittedByName || resp.submittedBy || 'Inspector',
        submittedAt: resp.createdAt ? new Date(resp.createdAt).toISOString() : new Date().toISOString()
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        formId,
        generatedAt: new Date().toISOString(),
        attempts
      }
    });
  } catch (error) {
    console.error('[ATTEMPTS] Error fetching attempts:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attempts' });
  }
};

/**
 * POST /api/responses/batch-sync
 * Accepts pending responses from mobile device, assigns real authoritative ranks, returns results.
 */
export const batchSyncResponses = async (req, res) => {
  try {
    const { responses } = req.body;
    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ success: false, message: 'responses array is required' });
    }

    const results = [];

    for (const item of responses) {
      const {
        idempotencyKey,
        formId,
        chassisNumber,
        answers,
        clientProvisionalRank,
        submittedAt,
        submittedBy
      } = item;

      let existing = null;
      if (idempotencyKey) {
        existing = await Response.findOne({
          $or: [
            { 'submissionMetadata.idempotencyKey': idempotencyKey },
            { 'submissionMetadata.sessionId': idempotencyKey },
            { sessionId: idempotencyKey }
          ]
        }).lean();
      }

      const chassis = chassisNumber || answers?.chassis_number || answers?.chassisNumber || 'UNKNOWN';

      let form = await Form.findOne({ id: formId });
      if (!form && mongoose.Types.ObjectId.isValid(formId)) {
        form = await Form.findById(formId);
      }
      const formIds = form ? getThisFormIds(form, formId) : [formId];

      const priorCount = await Response.countDocuments({
        $and: [
          { $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }] },
          {
            $or: [
              { chassisNumber: chassis },
              { 'answers.chassis_number': chassis },
              { 'answers.chassisNumber': chassis }
            ]
          }
        ]
      });

      if (existing) {
        results.push({
          idempotencyKey: idempotencyKey || existing._id.toString(),
          serverId: existing._id.toString(),
          assignedRank: existing.rank || (priorCount > 0 ? priorCount : 1)
        });
        continue;
      }

      const assignedRank = priorCount + 1;

      let subStatus = 'Direct Ok';
      if (answers && typeof answers === 'object') {
        const statuses = Object.values(answers)
          .map(v => typeof v === 'object' && v ? v.status : v)
          .map(v => String(v || '').toLowerCase());
        if (statuses.some(s => s.includes('reject'))) {
          subStatus = 'Rejected';
        } else if (statuses.some(s => s.includes('rework'))) {
          subStatus = 'Rework';
        }
      }

      const newResponse = new Response({
        questionId: formId,
        formId: formId,
        chassisNumber: chassis,
        rank: assignedRank,
        answers: answers || {},
        submittedBy: submittedBy || req.user?.username || 'Inspector Mobile',
        submittedByName: submittedBy || req.user?.displayName || req.user?.username || 'Inspector',
        status: subStatus === 'Direct Ok' ? 'pending' : subStatus.toLowerCase(),
        subStatus: subStatus,
        sessionId: idempotencyKey,
        submissionMetadata: {
          source: 'mobile-batch-sync',
          idempotencyKey: idempotencyKey,
          clientProvisionalRank: clientProvisionalRank
        },
        createdAt: submittedAt ? new Date(submittedAt) : new Date()
      });

      await newResponse.save();

      results.push({
        idempotencyKey: idempotencyKey || newResponse._id.toString(),
        serverId: newResponse._id.toString(),
        assignedRank: assignedRank
      });
    }

    return res.status(200).json({
      success: true,
      data: { results }
    });
  } catch (error) {
    console.error('[BATCH-SYNC] Error processing batch sync:', error);
    return res.status(500).json({ success: false, message: 'Failed to process batch sync' });
  }
};

/**
 * Get all previous unique answers for a specific question
 * Used to show suggestions to users as they fill the form
 */
export const getQuestionPreviousAnswers = async (req, res) => {
  try {
    const { formId: queryFormId, questionId } = req.query;
    const { tenantSlug, formId: paramFormId } = req.params;

    const formId = paramFormId || queryFormId;

    if (!formId || !questionId) {
      return res.status(400).json({ 
        success: false,
        message: 'formId and questionId are required'
      });
    }

    let tenantId;
    if (tenantSlug) {
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });
      if (tenant) {
        tenantId = tenant._id;
      }
    }

    // Find the form to verify it exists
    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) {
      form = await Form.findById(formId);
    }
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Use aggregation to find unique answers for this question
    // Check both normal ID and tracking suffixed ID
    const trackingQuestionId = `${questionId}_tracking`;
    const query = {
      questionId: { $in: [form.id, form._id.toString()] },
      $or: [
        { [`answers.${questionId}`]: { $exists: true, $ne: null, $ne: "" } },
        { [`answers.${trackingQuestionId}`]: { $exists: true, $ne: null, $ne: "" } },
        { [`answers._${questionId}`]: { $exists: true, $ne: null, $ne: "" } },
        { [`answers._${trackingQuestionId}`]: { $exists: true, $ne: null, $ne: "" } }
      ]
    };

    // If we have tenantId, filter by it for better accuracy/security
    if (tenantId) {
      query.tenantId = mongoose.Types.ObjectId.isValid(tenantId) ? new mongoose.Types.ObjectId(tenantId) : tenantId;
    } else if (form.isGlobal) {
      // For global forms without a specific tenant context, we don't filter by tenantId
      // This allows suggestions across different tenants for global forms
      console.log(`[SUGGESTIONS] Global form detected, skipping tenantId filter`);
    } else if (form.tenantId) {
      // Fallback to form's tenantId if slug wasn't provided but form belongs to a tenant
      query.tenantId = mongoose.Types.ObjectId.isValid(form.tenantId) ? new mongoose.Types.ObjectId(form.tenantId) : form.tenantId;
    }

    console.log(`[SUGGESTIONS] Querying previous answers for Form: ${formId}, Question: ${questionId}, Tenant: ${query.tenantId || 'N/A'}`);

    // Use aggregate for more reliable querying of Map fields and unique values
    // In MongoDB aggregation, fields within a Mongoose Map are accessed like normal nested fields: answers.key
    const pipeline = [
      { $match: query },
      {
        $project: {
          vals: [
            `$answers.${questionId}`,
            `$answers.${trackingQuestionId}`,
            `$answers._${questionId}`,
            `$answers._${trackingQuestionId}`
          ]
        }
      },
      { $unwind: "$vals" },
      { $match: { vals: { $ne: null, $ne: "" } } },
      {
        $group: {
          _id: "$vals"
        }
      },
      { $limit: 15 }
    ];

    console.log(`[SUGGESTIONS] Pipeline:`, JSON.stringify(pipeline, null, 2));

    const results = await Response.aggregate(pipeline);
    console.log(`[SUGGESTIONS] Found ${results.length} unique raw results`);

    const previousAnswers = results.map(r => r._id);
    console.log(`[SUGGESTIONS] Final answers list:`, previousAnswers);

    // Limit to top 10 unique answers to avoid overwhelming the UI
    const limitedAnswers = previousAnswers.slice(0, 10);

    return res.status(200).json({
      success: true,
      data: { answers: limitedAnswers }
    });

  } catch (error) {
    console.error('Get question previous answers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch previous answers'
    });
  }
};


/*export const batchImportResponses = async (req, res) => {
  // Declare batchId at the function scope
  let batchId;
  
  try {
    console.log('=== BATCH IMPORT ===');
    
    const { questionId, questionID, responses } = req.body;
    const actualQuestionId = questionId || questionID;
    
    // Set batchId at function scope
    batchId = req.body.batchId || `batch-${Date.now()}`;
    
    console.log('Batch ID:', batchId);
    console.log('Searching for form ID:', actualQuestionId);
    
    if (!actualQuestionId || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request'
      });
    }
    
    // Find form (without isVisible check for now)
    const form = await Form.findOne({ id: actualQuestionId });
    
    if (!form) {
      return res.status(404).json({
        success: false,
        message: `Form not found with ID: ${actualQuestionId}`
      });
    }
    
    console.log(`✅ Form found: "${form.title}"`);
    
    // Skip image checking for now - just save responses
    console.log('=== Saving responses ===');
    
    const createdResponses = [];
    const errors = [];
    
    // Save each response
    for (let index = 0; index < responses.length; index++) {
      try {
        const { answers, submittedBy, submitterContact } = responses[index];
        
        console.log(`Saving response ${index + 1}/${responses.length}`);
        
        // Create response data
        const responseData = {
          id: uuidv4(),
          questionId: actualQuestionId,
          answers: new Map(Object.entries(answers || {})),
          submittedBy: submittedBy || 'Excel Import',
          submitterContact: submitterContact || {},
          status: 'pending',
          tenantId: form.tenantId || null,
          createdAt: new Date()
        };
        
        // Save to database
        const response = new Response(responseData);
        await response.save();
        
        createdResponses.push({
          id: response.id,
          submittedBy: response.submittedBy,
          status: 'success'
        });
        
        console.log(`✅ Response ${index + 1} saved`);
        
      } catch (error) {
        console.error(`❌ Response ${index + 1} error:`, error.message);
        errors.push({
          index,
          error: error.message
        });
      }
    }
    
    // Send success response
    console.log('=== SENDING SUCCESS RESPONSE ===');
    return res.status(201).json({
      success: true,
      message: `Batch import completed: ${createdResponses.length} responses imported successfully`,
      data: {
        batchId,
        imported: createdResponses.length,
        total: responses.length,
        failed: errors.length,
        createdResponses: createdResponses.slice(0, 10), // Return first 10 only
        errors: errors.length > 0 ? errors : undefined
      }
    });
    
  } catch (error) {
    console.error('=== ERROR CATCH BLOCK ===');
    console.error('Error:', error.message);
    console.error('Batch ID during error:', batchId); // Now batchId is accessible
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error during batch import',
      batchId: batchId || 'unknown',
      error: error.message
    });
  }
}; */


export const processBulkImages = async (req, res) => {
  try {
    const { answers, batchId = `bulk-${Date.now()}` } = req.body;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: answers object required'
      });
    }

    console.log(`[BULK PROCESS] Starting bulk image processing for batch ${batchId}`);

    // Initialize WebSocket progress
    emitImageProgress(batchId, {
      status: 'starting',
      message: 'Initializing bulk image processing...',
      currentImage: 0,
      totalImages: 0
    });

    // Process images with progress tracking
    const onProgress = (progress) => {
      emitImageProgress(batchId, {
        status: progress.status,
        message: progress.message,
        currentImage: progress.currentImage,
        totalImages: progress.totalImages,
        percentage: progress.percentage
      });
    };

    const metadata = {
      tenantId: req.body.tenantId || null,
      formId: req.body.formId || null,
      submissionId: batchId,
      submissionTimestamp: Date.now()
    };

    const processedResult = await processResponseImages(
      answers,
      metadata,  // ADD THIS
      onProgress,
      batchId
    );
    // Final success message
    emitImageProgress(batchId, {
      status: 'complete',
      message: '✓ Bulk image processing completed successfully',
      currentImage: 100,
      totalImages: 100,
      percentage: 100
    });

    res.json({
      success: true,
      message: 'Bulk image processing completed',
      batchId,
      processedAnswers
    });

  } catch (error) {
    console.error('Bulk image processing error:', error);

    emitImageProgress(batchId, {
      status: 'error',
      message: `Processing failed: ${error.message}`,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Bulk image processing failed',
      error: error.message
    });
  }
};
export const getBiwSummary = async (req, res) => {
  try {
    const userRole = req.user?.role || 'admin';
    const userTenantId = req.user?.tenantId;

    let formQuery = {};
    if (userRole !== 'superadmin' && userTenantId) {
      const isValid = mongoose.Types.ObjectId.isValid(userTenantId);
      const oid = isValid ? new mongoose.Types.ObjectId(String(userTenantId)) : null;
      const tenantCondition = oid ? { $in: [userTenantId, String(userTenantId), oid] } : userTenantId;
      formQuery = {
        $or: [{ tenantId: tenantCondition }, { isGlobal: true }]
      };
    }

    const forms = await Form.find(formQuery).select('id _id').lean();
    const formIds = forms.flatMap(f => [f.id, f._id ? f._id.toString() : null]).filter(Boolean);

    let respQuery = {};
    if (userRole !== 'superadmin' && userTenantId) {
      const isValid = mongoose.Types.ObjectId.isValid(userTenantId);
      const oid = isValid ? new mongoose.Types.ObjectId(String(userTenantId)) : null;
      const tenantCondition = oid ? { $in: [userTenantId, String(userTenantId), oid] } : userTenantId;
      
      respQuery = {
        $or: [
          { tenantId: tenantCondition },
          ...(formIds.length > 0 ? [{ questionId: { $in: formIds } }] : [])
        ]
      };
    } else if (formIds.length > 0) {
      respQuery.questionId = { $in: formIds };
    }

    // Fast query returning lean response docs
    const responses = await Response.find(respQuery)
      .select('submittedBy createdBy isDispatched biwReview status answers')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[BIW] Total responses found: ${responses.length}`);

    // Group by user
    const byUser = new Map();

    responses.forEach(response => {
      const name = (response.submittedBy || response.createdBy || 'Anonymous').trim();

      if (!name || name === 'Excel Import' || name === 'System' || name === 'Admin Import' || name === '-') {
        return;
      }

      if (!byUser.has(name)) {
        byUser.set(name, {
          name,
          totalSubmitted: 0,
          dispatched: 0,
          accepted: 0,
          rejected: 0,
          rework: 0
        });
      }

      const stats = byUser.get(name);
      stats.totalSubmitted += 1;
      if (response.isDispatched) stats.dispatched += 1;

      // Extract review status from biwReview first, or fallback to response.status
      const biwStatus = response.biwReview?.status;
      const rawStatus = biwStatus || response.status;
      const statusStr = String(rawStatus || '').toLowerCase().trim();

      if (statusStr.includes('accept') || statusStr.includes('direct ok') || statusStr.includes('ok') || statusStr === 'verified') {
        stats.accepted += 1;
      } else if (statusStr.includes('reject')) {
        stats.rejected += 1;
      } else if (statusStr.includes('rework')) {
        stats.rework += 1;
      }
    });

    const result = Array.from(byUser.values()).map(stats => {
      const totalReviewed = stats.accepted + stats.rejected + stats.rework;
      const performanceScore = totalReviewed > 0
        ? Math.round((stats.accepted / totalReviewed) * 100)
        : 0;
      return { ...stats, totalReviewed, performanceScore };
    });

    res.json({
      success: true,
      data: result,
      totalResponses: responses.length
    });

  } catch (error) {
    console.error('BIW summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch BIW summary',
      error: error.message
    });
  }
};

export const getAllResponses = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      questionId,
      formIds,        // NEW: comma-separated list of form IDs to filter by
      status,
      assignedTo,
      search,
      startDate,
      endDate,
      includePartial = 'false'
    } = req.query;

    let query = {};
    if (req.user && req.user.role !== 'superadmin') {
      const userTenantIdStr = req.user.tenantId ? req.user.tenantId.toString() : '';
      const userTenantIdObj = mongoose.Types.ObjectId.isValid(userTenantIdStr)
        ? new mongoose.Types.ObjectId(userTenantIdStr)
        : null;
      const tenantValues = [userTenantIdStr, userTenantIdObj].filter(Boolean);

      // For Admin/Subadmin, if they have NO shared forms from other tenants, we can completely drop the expensive $or query
      // and just query by tenantId. This allows MongoDB to perfectly use the (tenantId, createdAt) index.
      const sharedForms = await Form.find({
        $or: [
          { sharedWithTenants: { $in: tenantValues } },
          { "chassisTenantAssignments.assignedTenants": userTenantIdStr }
        ],
        tenantId: { $nin: tenantValues } // Only forms they DON'T own
      }).select('id _id').lean();
      
      const sharedFormIds = sharedForms.flatMap(f => [f.id, f._id.toString()]).filter(Boolean);

      if (req.user.role === 'inspector') {
        const userEmail = req.user.email || '';
        const userUsername = req.user.username || '';
        const userId = req.user._id;

        // Find ALL accessible forms (owned + shared) for the inspector constraint
        const accessibleForms = await Form.find({
          $or: [
            { tenantId: { $in: tenantValues } },
            { sharedWithTenants: { $in: tenantValues } },
            { "chassisTenantAssignments.assignedTenants": userTenantIdStr }
          ]
        }).select('id _id').lean();
        const accessibleFormIds = accessibleForms.flatMap(f => [f.id, f._id.toString()]).filter(Boolean);

        // Inspector sees own submissions (any tenant) OR different tenant submissions,
        // but still limited to accessible forms!
        query.$and = [
          { questionId: { $in: accessibleFormIds } },
          {
            $or: [
              { createdBy: userId },
              { submittedBy: userEmail },
              { submittedBy: userUsername },
              { "submitterContact.email": userEmail },
              { tenantId: { $in: tenantValues } }
            ]
          }
        ];
      } else {
        // Admin / subadmin / other roles see:
        // - Responses in their own tenant, OR
        // - Responses for forms shared with their tenant!
        if (sharedFormIds.length > 0) {
          query.$or = [
            { tenantId: { $in: tenantValues } },
            { questionId: { $in: sharedFormIds } }
          ];
        } else {
          // HUGE optimization: No shared forms means we just query by tenantId!
          query.tenantId = { $in: tenantValues };
        }
      }
    } else {
      // Superadmin sees everything (no restriction)
      query = {};
    }

    // Filter out partial submissions unless explicitly requested
    if (includePartial !== 'true') {
      // Use $in instead of $ne because $ne breaks index prefixes in MongoDB
      query.isSectionSubmit = { $in: [false, null, undefined] };
    }

    // Filter by form (single ID)
    if (questionId) {
      query.questionId = questionId;
    }

    // Filter by multiple form IDs (comma-separated formIds param)
    if (formIds) {
      const formIdList = formIds.split(',').map(id => id.trim()).filter(Boolean);
      if (formIdList.length > 0) {
        // Override or combine with questionId filter
        if (query.questionId) {
          // Already filtering by single questionId — keep it
        } else {
          query.questionId = { $in: formIdList };
        }
      }
    }

    // Filter by status
    if (status && status !== 'all') {
      query.status = status;
    }

    // Filter by assigned user
    if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Search in answers or notes
    if (search) {
      query.$or = [
        { submittedBy: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } },
        { 'submitterContact.email': { $regex: search, $options: 'i' } }
      ];
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: [
        {
          path: 'assignedTo',
          select: 'username firstName lastName email'
        },
        {
          path: 'verifiedBy',
          select: 'username firstName lastName email'
        }
      ]
    };

    // Run find + count in parallel for speed
    const [responses, total] = await Promise.all([
      Response.find(query)
        .populate(options.populate[0].path, options.populate[0].select)
        .populate(options.populate[1].path, options.populate[1].select)
        .sort(options.sort)
        .limit(options.limit * 1)
        .skip((options.page - 1) * options.limit)
        .lean(),
      Response.countDocuments(query)
    ]);

    // Convert Map to Object for JSON serialization
    const formattedResponses = responses.map(response => {
      const responseObj = response;
      let answersObj = {};
      if (response.answers instanceof Map) {
        answersObj = Object.fromEntries(response.answers);
      } else if (response.answers && typeof response.answers === 'object') {
        answersObj = response.answers;
      }

      let ranksObj = {};
      if (response.responseRanks instanceof Map) {
        ranksObj = Object.fromEntries(response.responseRanks);
      } else if (response.responseRanks && typeof response.responseRanks === 'object') {
        ranksObj = response.responseRanks;
      }

      return {
        ...responseObj,
        answers: answersObj,
        responseRanks: ranksObj,
        submissionMetadata: responseObj.submissionMetadata || null
      };
    });

    res.json({
      success: true,
      data: {
        responses: formattedResponses,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalResponses: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get all responses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getResponseById = async (req, res) => {
  try {
    const { id } = req.params;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    const response = await Response.findOne(query)
      .populate('assignedTo', 'username firstName lastName email')
      .populate('verifiedBy', 'username firstName lastName email');

    if (!response || !(await canAccessResponseTenant(req, response))) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    // Convert Map to Object for JSON serialization
    const responseObj = response.toObject();
    const formattedResponse = {
      ...responseObj,
      answers: Object.fromEntries(response.answers),
      responseRanks: response.responseRanks ? Object.fromEntries(response.responseRanks) : {},
      submissionMetadata: responseObj.submissionMetadata || null
    };

    res.json({
      success: true,
      data: { response: formattedResponse }
    });

  } catch (error) {
    console.error('Get response by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateResponse = async (req, res) => {
  try {
    const { id } = req.params;
    const { answers, notes, status } = req.body;

    console.log('Updating response:', { id, answers: !!answers, notes, status, tenantFilter: req.tenantFilter });

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    let response = await Response.findOne(query);

    if (!response) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    if (!(await canAccessResponseTenant(req, response))) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    console.log('Found response:', !!response, response?._id);

    if (!response) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    // ✅ PRESERVE the createdBy field - don't let it be overwritten
    let originalCreatedBy = response.createdBy;
    let originalSubmittedBy = response.submittedBy;
    let originalSubmitterContact = response.submitterContact;

    if (req.body.submittedByUserId) {
      const User = mongoose.model('User');
      const matchedUser = await User.findById(req.body.submittedByUserId);
      if (matchedUser) {
        originalCreatedBy = matchedUser._id;
        originalSubmittedBy = `${matchedUser.firstName || ''} ${matchedUser.lastName || ''}`.trim() || matchedUser.username || matchedUser.email;
        originalSubmitterContact = {
          email: matchedUser.email || '',
          firstName: matchedUser.firstName || '',
          lastName: matchedUser.lastName || ''
        };
      }
    }

    // Update fields
    if (answers) {
      let processedAnswers = answers;
      try {
        const result = await processResponseImages(answers);
        processedAnswers = result.processedAnswers;
        console.log('[DEBUG] Updated answers with Google Drive image processing:', Object.keys(processedAnswers));
      } catch (error) {
        console.error('[ERROR] Failed to process Google Drive images on update:', error);
      }
      response.answers = new Map(Object.entries(processedAnswers));
    }
    if (notes !== undefined) {
      response.notes = notes;
    }
    if (status) {
      response.status = status;
      if (status === 'verified') {
        response.verifiedBy = req.user._id;
        response.verifiedAt = new Date();
      }
    }
    if (req.body.isDispatched !== undefined) {
      if (req.body.isDispatched === true && !response.isDispatched) {
        response.isDispatched = true;
        response.dispatchedAt = new Date();
        response.dispatchedBy = req.user._id;
        response.dispatchedByName =
          `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() ||
          req.user.username ||
          req.user.email ||
          'Unknown user';
      } else if (req.body.isDispatched === false) {
        response.isDispatched = false;
        response.dispatchedAt = null;
        response.dispatchedBy = null;
        response.dispatchedByName = null;
      }
    }

    // ✅ BIW Review — any reviewer other than the response's own submitter
    // can Accept / Reject / Rework. Send `{ biwReview: { status } }` to set
    // it, or `{ biwReview: null }` to clear it. reviewedBy/reviewedAt are
    // always set server-side from the authenticated user, never trusted
    // from the client.
    if (req.body.hasOwnProperty('biwReview')) {
      const biwReview = req.body.biwReview;

      if (biwReview === null || biwReview === undefined) {
        response.biwReview = undefined;
      } else {
        const allowedStatuses = ['Accepted', 'Rejected', 'Reworked'];
        if (!allowedStatuses.includes(biwReview.status)) {
          return res.status(400).json({
            success: false,
            message: `Invalid biwReview status. Must be one of: ${allowedStatuses.join(', ')}`
          });
        }

        const userEmail = req.user.email || '';
        const userUsername = req.user.username || '';
        const userIdStr = req.user._id ? req.user._id.toString() : '';
        const creatorIdStr = originalCreatedBy ? originalCreatedBy.toString() : '';
        const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
        const isExcelImport = originalSubmittedBy === 'Excel Import';

        const isSubmitter =
          !isAdmin &&
          !isExcelImport &&
          (
            originalSubmittedBy === userEmail ||
            originalSubmittedBy === userUsername ||
            (originalSubmitterContact && originalSubmitterContact.email === userEmail) ||
            (creatorIdStr && creatorIdStr === userIdStr)
          );

        if (isSubmitter) {
          return res.status(403).json({
            success: false,
            message: 'You cannot BIW review your own submission'
          });
        }

        response.biwReview = {
          status: biwReview.status,
          reviewedBy: req.user._id,
          reviewedByName: userUsername || userEmail || 'Reviewer',
          reviewedAt: new Date()
        };
      }
    }

    // ✅ Restore original creator info if they were accidentally changed
    response.createdBy = originalCreatedBy;
    response.submittedBy = originalSubmittedBy;
    response.submitterContact = originalSubmitterContact;

    await response.save();

    console.log('Response saved successfully');

    // Convert Map to Object for JSON serialization
    const formattedResponse = {
      ...response.toObject(),
      answers: Object.fromEntries(response.answers),
      responseRanks: response.responseRanks ? Object.fromEntries(response.responseRanks) : {}
    };

    // Emit real-time event for updated response
    emitResponseUpdated(response.questionId, {
      id: response.id,
      questionId: response.questionId,
      status: response.status,
      submittedBy: response.submittedBy,
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
      answers: Object.fromEntries(response.answers),
      responseRanks: response.responseRanks ? Object.fromEntries(response.responseRanks) : {}
    });

    res.json({
      success: true,
      message: 'Response updated successfully',
      data: { response: formattedResponse }
    });

  } catch (error) {
    console.error('Update response error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Auto-fill any response for this form whose chassis_number answer is
// missing/blank with the first chassis number configured on the form
// (same "master list" the dashboard dropdown uses), in a single bulk
// database operation instead of one request per response.
export const autoFillChassisNumbers = async (req, res) => {
  try {
    const { formId } = req.params;

    if (!formId) {
      return res.status(400).json({
        success: false,
        message: 'Form ID is required'
      });
    }

    // Find the form the same way getResponsesByForm does, so tenant sharing
    // rules (owner / shared / chassis-assignment) are respected here too.
    let formSearchQuery = { id: formId };

    if (req.user.role !== 'superadmin' && !req.user.isGuest && req.user.tenantId) {
      const tenantId = req.user.tenantId instanceof mongoose.Types.ObjectId
        ? req.user.tenantId
        : new mongoose.Types.ObjectId(req.user.tenantId);
      const tenantIdStr = tenantId.toString();

      formSearchQuery.$or = [
        { tenantId: tenantId },
        { sharedWithTenants: tenantId },
        { "chassisTenantAssignments.assignedTenants": tenantIdStr }
      ];
    }

    let form = await Form.findOne(formSearchQuery);

    if (!form && mongoose.Types.ObjectId.isValid(formId)) {
      const alternateQuery = { _id: formId };
      if (formSearchQuery.$or) alternateQuery.$or = formSearchQuery.$or;
      form = await Form.findOne(alternateQuery);
    }

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Build the same master chassis option list the frontend dropdown
    // shows, sorted the same way (alphabetically by label), and take the
    // first one as the default value to apply.
    const seen = new Set();
    const options = [];

    (form.chassisNumbers || []).forEach(entry => {
      const num = entry?.chassisNumber;
      if (num && !seen.has(String(num))) {
        seen.add(String(num));
        options.push({
          value: String(num),
          label: entry.partDescription ? `${num} — ${entry.partDescription}` : String(num)
        });
      }
    });

    if (options.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'This form has no chassis numbers configured, so there is no default value to apply.'
      });
    }

    options.sort((a, b) => a.label.localeCompare(b.label));
    const defaultValue = options[0].value;

    // Match every response for this form (respecting tenant filter) whose
    // chassis_number answer is missing, null, or an empty string.
    const query = {
      questionId: { $in: [form.id, form._id.toString()] },
      ...req.tenantFilter,
      $or: [
        { 'answers.chassis_number': { $exists: false } },
        { 'answers.chassis_number': null },
        { 'answers.chassis_number': '' }
      ]
    };

    const result = await Response.updateMany(
      query,
      { $set: { 'answers.chassis_number': defaultValue } }
    );

    console.log(`[AUTO-FILL CHASSIS] Form ${formId}: matched ${result.matchedCount}, modified ${result.modifiedCount}, default "${defaultValue}"`);

    res.json({
      success: true,
      message: `${result.modifiedCount} response(s) auto-filled with default chassis number`,
      data: {
        defaultValue,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Auto-fill chassis numbers error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const assignResponse = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    const response = await Response.findOne(query);

    if (!response || !(await canAccessResponseTenant(req, response))) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    response.assignedTo = assignedTo;
    response.assignedAt = new Date();
    await response.save();

    await response.populate('assignedTo', 'username firstName lastName email');

    // Convert Map to Object for JSON serialization
    const formattedResponse = {
      ...response.toObject(),
      answers: Object.fromEntries(response.answers)
    };

    res.json({
      success: true,
      message: 'Response assigned successfully',
      data: { response: formattedResponse }
    });

  } catch (error) {
    console.error('Assign response error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteResponse = async (req, res) => {
  try {
    const { id } = req.params;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    const response = await Response.findOne(query);

    if (!response || !(await canAccessResponseTenant(req, response))) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    const questionId = response.questionId || response.formId;
    await Response.findOneAndDelete({ _id: response._id });

    // Emit real-time event for deleted response (using response.id which is the UUID expected by frontend socket listener)
    emitResponseDeleted(questionId, response.id || response._id.toString());

    // Invalidate server memory cache so subsequent requests return fresh results
    suggestionsMemoryCache.clear();
    invalidateCache('responses');
    if (questionId) invalidateCache(String(questionId));

    res.json({
      success: true,
      message: 'Response deleted successfully'
    });

  } catch (error) {
    console.error('Delete response error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteMultipleResponses = async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of response IDs'
      });
    }

    const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const findQuery = {
      $or: [
        { id: { $in: ids } },
        { _id: { $in: objectIds } }
      ]
    };

    const candidateResponses = await Response.find(findQuery).select('id _id questionId tenantId');
    const accessChecks = await Promise.all(
      candidateResponses.map(async (r) => ({
        doc: r,
        allowed: await canAccessResponseTenant(req, r),
      })),
    );
    const allowedDocs = accessChecks.filter((c) => c.allowed).map((c) => c.doc);
    const allowedDbIds = allowedDocs.map((doc) => doc._id);

    if (allowedDbIds.length === 0) {
      return res.json({
        success: true,
        message: '0 responses deleted successfully'
      });
    }

    const result = await Response.deleteMany({ _id: { $in: allowedDbIds } });

    // Invalidate server memory cache so subsequent requests return fresh results
    suggestionsMemoryCache.clear();
    invalidateCache('responses');

    res.json({
      success: true,
      message: `${result.deletedCount} responses deleted successfully`
    });

  } catch (error) {
    console.error('Delete multiple responses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getResponsesByForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const { page = 1, limit = 200, status, includePartial = 'false' } = req.query;

    console.log('[getResponsesByForm] Looking for form with ID:', formId);
    // Verify form exists - support either string id or mongo _id in a single lookup
    const isObjectId = mongoose.Types.ObjectId.isValid(formId);
    let formSearchQuery = isObjectId
      ? { $or: [{ id: formId }, { _id: new mongoose.Types.ObjectId(formId) }] }
      : { id: formId };

    // If not superadmin and not admin and not guest, check if form belongs to or is shared with this tenant
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin' && !req.user.isGuest && req.user.tenantId) {
      const tenantIdStr = req.user.tenantId.toString();
      const tenantIdObj = mongoose.Types.ObjectId.isValid(tenantIdStr)
        ? new mongoose.Types.ObjectId(tenantIdStr)
        : null;
      const tenantValues = [tenantIdStr, tenantIdObj].filter(Boolean);

      const tenantOr = [
        { tenantId: { $in: tenantValues } },
        { sharedWithTenants: { $in: tenantValues } },
        { "chassisTenantAssignments.assignedTenants": tenantIdStr }
      ];

      if (formSearchQuery.$or) {
        formSearchQuery = {
          $and: [
            { $or: formSearchQuery.$or },
            { $or: tenantOr }
          ]
        };
      } else {
        formSearchQuery.$or = tenantOr;
      }
    }

    let form = await Form.findOne(formSearchQuery);
    console.log('[getResponsesByForm] Form found:', !!form);

    if (!form) {
      console.log('[getResponsesByForm] Form not found with query:', JSON.stringify(formSearchQuery));
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Determine access level
    const isGuest = !!req.user.isGuest;
    const userIdStr = req.user._id ? req.user._id.toString() : 'guest';
    const userTenantIdStr = req.user.tenantId ? req.user.tenantId.toString() : null;
    const isSuperAdmin = req.user.role === 'superadmin';
    const isOwner = !isGuest && form.tenantId && form.tenantId.toString() === userTenantIdStr;
    const isShared = !isGuest && form.sharedWithTenants && form.sharedWithTenants.some(t => t.toString() === userTenantIdStr);
    const hasChassisShare = !isGuest && Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.some(
      a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr)
    );

    // Build response query: strictly isolate responses to this form alone
    const targetQuestionIds = [form.id, form._id ? form._id.toString() : null].filter(Boolean);

    // Only include linked child follow-up forms if explicitly requested via scope='all' or includeChildren='true'
    if (req.query.scope === 'all' || req.query.includeChildren === 'true') {
      if (form.childForms && form.childForms.length > 0) {
        form.childForms.forEach(cf => {
          if (cf.formId) targetQuestionIds.push(cf.formId);
          if (cf.id) targetQuestionIds.push(cf.id);
          if (cf._id) targetQuestionIds.push(cf._id.toString());
        });
      }

      try {
        const parentIdentifiers = [form.id, form._id ? form._id.toString() : null].filter(Boolean);
        const dbChildForms = await Form.find({
          parentFormId: { $in: parentIdentifiers }
        }).select('id _id').lean();

        dbChildForms.forEach(cf => {
          if (cf.id) targetQuestionIds.push(cf.id);
          if (cf._id) targetQuestionIds.push(cf._id.toString());
        });
      } catch (err) {
        console.warn('[getResponsesByForm] Error fetching dbChildForms:', err);
      }
    }

    const uniqueQuestionIds = Array.from(new Set(targetQuestionIds.filter(Boolean)));
    const query = { questionId: { $in: uniqueQuestionIds } };

    // Add status filter if provided
    if (status && status !== 'all') {
      query.status = status;
    }

    // Add batchId or uploadOnly filter if provided
    if (req.query.batchId) {
      query.batchId = req.query.batchId;
    } else if (req.query.uploadOnly === 'true') {
      query.$or = [
        { batchId: { $exists: true, $ne: null } },
        { submittedBy: 'Excel Import' }
      ];
    }

    // Add partial submission filter
    if (includePartial !== 'true') {
      query.isSectionSubmit = { $ne: true };
    }

    // Add normalized date range filter if provided
    const { startDate, endDate } = req.query;
    if (startDate || endDate) {
      const dateFilterQuery = {};
      if (startDate) {
        const sDate = new Date(startDate);
        sDate.setUTCHours(0, 0, 0, 0);
        // 6-hour buffer before UTC midnight ensures morning shifts in IST (UTC+5:30) are included
        const sDateBuffer = new Date(sDate.getTime() - 6 * 3600 * 1000);
        dateFilterQuery.$gte = sDateBuffer;
      }
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setUTCHours(23, 59, 59, 999);
        // 12-hour buffer covers night shifts extending past UTC day end
        const eDateBuffer = new Date(eDate.getTime() + 12 * 3600 * 1000);
        dateFilterQuery.$lte = eDateBuffer;
      }
      if (!query.$and) query.$and = [];
      query.$and.push({
        $or: [
          { createdAt: dateFilterQuery },
          { submittedAt: dateFilterQuery }
        ]
      });
    }

    // Apply granular chassis filtering for chassis-shared users BEFORE querying MongoDB
    if (!isSuperAdmin && !isOwner && hasChassisShare && !isShared) {
      const myAssignedChassis = (form.chassisTenantAssignments || [])
        .filter(a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr))
        .map(a => a.chassisNumber)
        .filter(Boolean);

      if (myAssignedChassis.length > 0) {
        const chassisQuestion = form.sections?.flatMap(s => s.questions || []).find(q => q.type === 'chassisNumber')
          || form.followUpQuestions?.find(q => q.type === 'chassisNumber');
        const chassisFieldId = chassisQuestion?.id || 'chassis_number';
        
        // Push the filter to mongo natively 
        // e.g., answers.12345: { $in: ["CHAS1", "CHAS2"] }
        query[`answers.${chassisFieldId}`] = { $in: myAssignedChassis };
      } else {
        // They have chassis share access, but zero chassis assigned? Return empty.
        query._id = null; // Impossible query to force empty results
      }
    }

    // Apply tenant filtering
    console.log('[GET RESPONSES] Inspector check - role:', req.user.role, 'userId:', req.user._id, 'tenantId:', req.user.tenantId, 'email:', req.user.email);
    if (req.user.role === 'inspector') {
      const userEmail = req.user.email || '';
      const userUsername = req.user.username || '';
      const userId = req.user._id;
      const userTenantId = req.user.tenantId;

      query.$or = [
        { createdBy: userId },
        { submittedBy: userEmail },
        { submittedBy: userUsername },
        { "submitterContact.email": userEmail },
        { tenantId: { $ne: userTenantId } }
      ];

      console.log('[INSPECTOR] Filtering responses for user with inspector visibility rules:', userId, userEmail);
      console.log('[INSPECTOR] Query $or:', JSON.stringify(query.$or));
    } else if (isOwner || isSuperAdmin) {
      Object.assign(query, req.tenantFilter);
    } else if (req.user.role === 'admin') {
      // Admins viewing a form can view the form's responses
    } else if (!isShared && !hasChassisShare) {
      Object.assign(query, req.tenantFilter);
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    };

    const isAnalytics = req.query.analytics === 'true';

    let responsesQuery = Response.find(query);
    if (isAnalytics) {
      responsesQuery = responsesQuery.select(
        '_id id questionId formId status answers submissionMetadata responseRanks chassisNumber batchId notes score parentResponseId submitterContact inviteId createdAt timestamp submittedBy createdBy isDispatched dispatchedAt dispatchedBy dispatchedByName biwReview submittedAt tenantId timeSpent totalTimeSpent startedAt completedAt'
      );
    } else {
      responsesQuery = responsesQuery
        .select(
          '_id id questionId formId status answers submissionMetadata responseRanks chassisNumber batchId notes score parentResponseId submitterContact inviteId createdAt timestamp submittedBy createdBy assignedTo verifiedBy isDispatched dispatchedAt dispatchedBy dispatchedByName biwReview submittedAt tenantId timeSpent totalTimeSpent startedAt completedAt'
        )
        .populate('assignedTo', 'username firstName lastName email')
        .populate('verifiedBy', 'username firstName lastName email')
        .populate('createdBy', 'username firstName lastName email');
    }

    const responsesPromise = responsesQuery
        .sort(options.sort)
        .limit(options.limit * 1)
        .skip((options.page - 1) * options.limit)
        .maxTimeMS(30000)
        .lean();
    
    const countPromise = Response.countDocuments(query).maxTimeMS(15000);

    const [responsesRaw, total] = await Promise.all([responsesPromise, countPromise]);
    let responses = responsesRaw;
    if (isAnalytics) {
      responses = responsesRaw.map(r => {
        if (r.answers instanceof Map) {
          r.answers = Object.fromEntries(r.answers);
        }
        return r;
      });
    }

    console.log('[GET RESPONSES] Query:', JSON.stringify(query));
    console.log('[GET RESPONSES] Responses found:', responses.length);

    let reviewsByResponse = {};
    let messagesByResponse = {};

    if (responses.length > 0) {
      const responseIds = responses.flatMap(r => [r.id, r._id ? r._id.toString() : null]).filter(Boolean);
      const [reviews, chatMessages] = await Promise.all([
        Review.find({ responseId: { $in: responseIds } })
          .select('responseId reviewerName reviewerId reviewOption createdAt')
          .populate('reviewerId', 'firstName lastName email username')
          .sort({ createdAt: -1 })
          .lean(),
        ChatMessage.find({
          responseId: { $in: responseIds },
          questionContexts: { $exists: true, $not: { $size: 0 } }
        })
          .select('responseId questionContexts createdAt')
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      reviewsByResponse = reviews.reduce((acc, r) => {
        if (!acc[r.responseId]) {
          acc[r.responseId] = r;
        }
        return acc;
      }, {});

      messagesByResponse = chatMessages.reduce((acc, m) => {
        if (!acc[m.responseId]) {
          acc[m.responseId] = m;
        }
        return acc;
      }, {});
    }

    // Helper to safely extract chassis from any response document
    const getChassisFromDoc = (doc) => {
      const ans = doc.answers instanceof Map ? Object.fromEntries(doc.answers) : (doc.answers || {});
      const val = extractAnswerString(
        ans.chassis_number ||
        ans.chassisNumber ||
        ans.id_number ||
        ans.idNumber ||
        ans['ID number'] ||
        ans['Chassis / VIN'] ||
        ans['Chassis No'] ||
        ans['CHASSIS NUMBER'] ||
        doc.chassisNumber ||
        (Object.keys(ans).length === 1 ? Object.values(ans)[0] : null)
      );
      return val ? String(val).trim() : null;
    };

    // Calculate Parent <-> Child Form follow-up status for each chassis
    const parentFormIdStr = form.parentFormId ? form.parentFormId.toString() : null;
    const isChildForm = Boolean(parentFormIdStr);

    let childFormIds = (form.childForms || []).map(cf => cf.formId || cf.id || cf._id?.toString()).filter(Boolean);
    if (childFormIds.length === 0) {
      try {
        const potentialChildForms = await Form.find({
          parentFormId: { $in: [form.id, form._id ? form._id.toString() : null].filter(Boolean) }
        }).select('id _id title').lean();
        if (potentialChildForms.length > 0) {
          childFormIds = potentialChildForms.map(cf => cf.id || (cf._id ? cf._id.toString() : null)).filter(Boolean);
        }
      } catch (cfErr) {
        console.warn('[getResponsesByForm] Error finding child forms by parentFormId:', cfErr);
      }
    }
    const isParentForm = childFormIds.length > 0;

    const parentChassisMap = new Map();
    const parentByIdMap = new Map();
    const childChassisMap = new Map();

    const hasFollowUpResponsesInBatch = responses.some(r =>
      r.parentResponseId || (r.batchId && (r.batchId.includes('-t2') || r.batchId.includes('-fu-')))
    );

    // Query parent/child matches if we have responses on this page and this form has parent/child relationships or follow-up responses
    if (responses.length > 0 && (isChildForm || isParentForm || hasFollowUpResponsesInBatch)) {
      const pageChassisList = responses.map(r => getChassisFromDoc(r)).filter(Boolean);
      const pageChassisSet = new Set(pageChassisList.map(c => c.toLowerCase().trim()));
      const chassisStrings = Array.from(pageChassisSet);
      const matchPromises = [];

      // 1. Direct parentResponseId lookup
      const directParentIds = responses.map(r => r.parentResponseId).filter(Boolean);
      if (directParentIds.length > 0) {
        const validObjectIds = directParentIds.filter(id => mongoose.Types.ObjectId.isValid(id));
        matchPromises.push(
          Response.find({
            $or: [
              { id: { $in: directParentIds } },
              { _id: { $in: validObjectIds } }
            ]
          })
            .select('answers createdAt id _id status submittedBy chassisNumber')
            .lean()
            .then(parentResponses => {
              parentResponses.forEach(pr => {
                const prId = pr.id || (pr._id ? pr._id.toString() : null);
                if (prId) parentByIdMap.set(prId, pr);
                const pVal = getChassisFromDoc(pr);
                if (pVal) {
                  const norm = pVal.toLowerCase().trim();
                  if (!parentChassisMap.has(norm)) {
                    parentChassisMap.set(norm, {
                      hasResponse: true,
                      responseCount: 1,
                      latestCreatedAt: pr.createdAt,
                      status: pr.status || 'Accepted',
                      submittedBy: pr.submittedBy || 'Inspector',
                      responseId: prId,
                      chassis: pVal
                    });
                  }
                }
              });
            })
            .catch(err => console.warn('[getResponsesByForm] Error fetching direct parents by ID:', err))
        );
      }

      // 2. Child lookup by parentResponseId (responses where parentResponseId points to this page's responses)
      const pageResponseIds = responses.map(r => r.id).concat(responses.map(r => r._id ? r._id.toString() : null)).filter(Boolean);
      if (pageResponseIds.length > 0) {
        matchPromises.push(
          Response.find({
            parentResponseId: { $in: pageResponseIds },
            isSectionSubmit: { $ne: true }
          })
            .select('answers createdAt id _id status submittedBy chassisNumber parentResponseId')
            .lean()
            .then(childResponses => {
              childResponses.forEach(cr => {
                const cVal = getChassisFromDoc(cr);
                if (cVal) {
                  const norm = cVal.toLowerCase().trim();
                  if (!childChassisMap.has(norm)) {
                    childChassisMap.set(norm, {
                      hasResponse: true,
                      responseCount: 1,
                      latestCreatedAt: cr.createdAt,
                      status: cr.status || 'Direct Ok',
                      submittedBy: cr.submittedBy || 'Inspector',
                      responseId: cr.id || (cr._id ? cr._id.toString() : null),
                      chassis: cVal
                    });
                  }
                }
              });
            })
            .catch(err => console.warn('[getResponsesByForm] Error fetching children by parentResponseId:', err))
        );
      }

      // 3. Query parent responses by chassis
      if (chassisStrings.length > 0 && (isChildForm || isParentForm || hasFollowUpResponsesInBatch)) {
        const parentFormIds = parentFormIdStr ? [parentFormIdStr] : [form.id, form._id ? form._id.toString() : null].filter(Boolean);
        const parentQuery = {
          questionId: { $in: parentFormIds },
          isSectionSubmit: { $ne: true },
          $or: [
            { chassisNumber: { $in: chassisStrings } },
            { 'answers.chassis_number': { $in: chassisStrings } },
            { 'answers.chassisNumber': { $in: chassisStrings } },
            { 'answers.id_number': { $in: chassisStrings } },
            { 'answers.idNumber': { $in: chassisStrings } },
            { 'answers.Chassis / VIN': { $in: chassisStrings } },
            { 'answers.Chassis No': { $in: chassisStrings } },
            { 'answers.CHASSIS NUMBER': { $in: chassisStrings } }
          ]
        };

        matchPromises.push(
          Response.find(parentQuery)
            .select('answers createdAt id _id status submittedBy chassisNumber')
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean()
            .then(parentResponses => {
              parentResponses.forEach(pr => {
                const pVal = getChassisFromDoc(pr);
                if (pVal) {
                  const norm = pVal.toLowerCase().trim();
                  if (!parentChassisMap.has(norm)) {
                    parentChassisMap.set(norm, {
                      hasResponse: true,
                      responseCount: 1,
                      latestCreatedAt: pr.createdAt,
                      status: pr.status || 'Accepted',
                      submittedBy: pr.submittedBy || 'Inspector',
                      responseId: pr.id || (pr._id ? pr._id.toString() : null),
                      chassis: pVal
                    });
                  } else {
                    const cur = parentChassisMap.get(norm);
                    cur.responseCount++;
                  }
                }
              });
            })
            .catch(err => console.warn('[getResponsesByForm] Error fetching parent responses for matching:', err))
        );
      }

      // 4. Query child responses across child forms by chassis
      if (chassisStrings.length > 0 && childFormIds.length > 0) {
        const childQuery = {
          questionId: { $in: childFormIds },
          isSectionSubmit: { $ne: true },
          $or: [
            { chassisNumber: { $in: chassisStrings } },
            { 'answers.chassis_number': { $in: chassisStrings } },
            { 'answers.chassisNumber': { $in: chassisStrings } },
            { 'answers.id_number': { $in: chassisStrings } },
            { 'answers.idNumber': { $in: chassisStrings } },
            { 'answers.Chassis / VIN': { $in: chassisStrings } },
            { 'answers.Chassis No': { $in: chassisStrings } },
            { 'answers.CHASSIS NUMBER': { $in: chassisStrings } }
          ]
        };

        matchPromises.push(
          Response.find(childQuery)
            .select('answers createdAt id _id status submittedBy chassisNumber')
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean()
            .then(childResponses => {
              childResponses.forEach(cr => {
                const cVal = getChassisFromDoc(cr);
                if (cVal) {
                  const norm = cVal.toLowerCase().trim();
                  if (!childChassisMap.has(norm)) {
                    childChassisMap.set(norm, {
                      hasResponse: true,
                      responseCount: 1,
                      latestCreatedAt: cr.createdAt,
                      status: cr.status || 'Direct Ok',
                      submittedBy: cr.submittedBy || 'Inspector',
                      responseId: cr.id || (cr._id ? cr._id.toString() : null),
                      chassis: cVal
                    });
                  } else {
                    const cur = childChassisMap.get(norm);
                    cur.responseCount++;
                  }
                }
              });
            })
            .catch(err => console.warn('[getResponsesByForm] Error fetching child responses for matching:', err))
        );
      }

      // 5. Query same-form follow-ups (Template 2 / -t2 / -fu- batches) by chassis
      if (chassisStrings.length > 0) {
        const sameFormFollowUps = {
          questionId: { $in: [form.id, form._id ? form._id.toString() : null].filter(Boolean) },
          isSectionSubmit: { $ne: true },
          $or: [
            { parentResponseId: { $exists: true, $ne: null } },
            { batchId: { $regex: /-t2|-fu-/i } }
          ],
          $and: [
            {
              $or: [
                { chassisNumber: { $in: chassisStrings } },
                { 'answers.chassis_number': { $in: chassisStrings } },
                { 'answers.chassisNumber': { $in: chassisStrings } },
                { 'answers.id_number': { $in: chassisStrings } },
                { 'answers.idNumber': { $in: chassisStrings } },
                { 'answers.Chassis / VIN': { $in: chassisStrings } },
                { 'answers.Chassis No': { $in: chassisStrings } },
                { 'answers.CHASSIS NUMBER': { $in: chassisStrings } }
              ]
            }
          ]
        };

        matchPromises.push(
          Response.find(sameFormFollowUps)
            .select('answers createdAt id _id status submittedBy chassisNumber batchId parentResponseId')
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean()
            .then(childResponses => {
              childResponses.forEach(cr => {
                const cVal = getChassisFromDoc(cr);
                if (cVal) {
                  const norm = cVal.toLowerCase().trim();
                  if (!childChassisMap.has(norm)) {
                    childChassisMap.set(norm, {
                      hasResponse: true,
                      responseCount: 1,
                      latestCreatedAt: cr.createdAt,
                      status: cr.status || 'Direct Ok',
                      submittedBy: cr.submittedBy || 'Inspector',
                      responseId: cr.id || (cr._id ? cr._id.toString() : null),
                      chassis: cVal
                    });
                  }
                }
              });
            })
            .catch(err => console.warn('[getResponsesByForm] Error fetching same-form followups for matching:', err))
        );
      }

      await Promise.all(matchPromises);
    }

    // With .lean(), `response` is already a plain object (no .toObject(),
    // and Map-typed fields like `answers`/`responseRanks` come back as
    // plain objects rather than Map instances) — handle both shapes so
    // this keeps working if lean() is ever removed on this path.
    const formattedResponses = responses.map(response => {
      const responseObj = typeof response.toObject === 'function' ? response.toObject() : response;
      const review = reviewsByResponse[response.id];
      const message = messagesByResponse[response.id];

      // Determine the best display name for submittedBy
      let displaySubmittedBy = response.submittedBy;

      // If submittedBy is "Anonymous" or missing, try to get from createdBy
      if (!displaySubmittedBy || displaySubmittedBy === 'Anonymous') {
        if (response.createdBy) {
          if (typeof response.createdBy === 'object') {
            const firstName = response.createdBy.firstName || '';
            const lastName = response.createdBy.lastName || '';
            const fullName = `${firstName} ${lastName}`.trim();
            displaySubmittedBy = fullName || response.createdBy.email || response.createdBy.username;
          } else if (typeof response.createdBy === 'string') {
            displaySubmittedBy = response.createdBy;
          }
        }
      }

      // If still empty, use email from submitterContact
      if (!displaySubmittedBy || displaySubmittedBy === 'Anonymous') {
        displaySubmittedBy = response.submitterContact?.email || 'Anonymous';
      }

      // Attach review info
      const reviewInfo = review ? {
        status: review.reviewOption,
        reviewer: review.reviewerName || (review.reviewerId ? (review.reviewerId.firstName ? `${review.reviewerId.firstName} ${review.reviewerId.lastName}` : review.reviewerId.username) : 'Reviewer'),
        flaggedQuestions: message ? message.questionContexts.map(c => c.title) : []
      } : null;

      const toPlainObject = (val) => {
        if (!val) return {};
        return val instanceof Map ? Object.fromEntries(val) : val;
      };

      const respAnswers = toPlainObject(response.answers);

      // Check if this particular response is from a child follow-up form or parent form
      const respQIdStr = String(response.questionId || response.formId || '');
      const isResponseFromChild = isChildForm ||
        (childFormIds.length > 0 && childFormIds.includes(respQIdStr)) ||
        Boolean(response.parentResponseId) ||
        (response.batchId && (response.batchId.includes('-t2') || response.batchId.includes('-fu-')));

      // Calculate Follow-up & Parent Match Status for Chassis
      let followUpStatus = null;
      const chassisVal = getChassisFromDoc(response);

      if (chassisVal) {
        const norm = chassisVal.toLowerCase().trim();

        if (isResponseFromChild) {
          // This is a follow-up response -> match up with parent responses!
          const directParent = response.parentResponseId ? parentByIdMap.get(response.parentResponseId) : null;
          const pMatch = directParent || (norm ? parentChassisMap.get(norm) : null);
          if (pMatch) {
            const parentChassis = pMatch.chassis || getChassisFromDoc(pMatch) || chassisVal;
            followUpStatus = {
              isMatched: true,
              matchType: 'parent',
              status: 'matched',
              label: 'Parent Matched',
              badgeText: '✓ Parent Matched',
              color: 'emerald',
              parentStatus: pMatch.status || 'Accepted',
              parentSubmittedBy: pMatch.submittedBy || 'Inspector',
              parentCreatedAt: pMatch.createdAt || pMatch.latestCreatedAt,
              parentResponseId: response.parentResponseId || pMatch.id || pMatch.responseId,
              matchedChassis: parentChassis,
              details: `Matched parent chassis "${parentChassis}" (Status: ${pMatch.status || 'Accepted'}) by ${pMatch.submittedBy || 'Inspector'}`
            };
          } else {
            followUpStatus = {
              isMatched: false,
              matchType: 'parent',
              status: 'unmatched',
              label: 'No Parent Match',
              badgeText: '⚠ No Parent Match',
              color: 'amber',
              matchedChassis: chassisVal,
              details: `Chassis "${chassisVal}" has not been inspected in parent form yet`
            };
          }
        } else if (isParentForm || childFormIds.length > 0 || hasFollowUpResponsesInBatch) {
          // This is a main form response -> check if follow-up exists
          const hasChildMatch = childChassisMap.has(norm);
          if (hasChildMatch) {
            const cMatch = childChassisMap.get(norm);
            followUpStatus = {
              isMatched: true,
              matchType: 'child',
              status: 'matched',
              label: 'Follow-up Complete',
              badgeText: '✓ Follow-up Done',
              color: 'emerald',
              followUpStatus: cMatch.status || 'Direct Ok',
              followUpSubmittedBy: cMatch.submittedBy || 'Inspector',
              followUpCreatedAt: cMatch.latestCreatedAt || cMatch.createdAt,
              followUpResponseId: cMatch.responseId || cMatch.id,
              matchedChassis: cMatch.chassis || chassisVal,
              details: `Follow-up completed for chassis "${cMatch.chassis || chassisVal}" by ${cMatch.submittedBy || 'Inspector'}`
            };
          } else {
            const createdAtDate = response.createdAt ? new Date(response.createdAt) : new Date();
            const daysElapsed = Math.floor((Date.now() - createdAtDate.getTime()) / (1000 * 60 * 60 * 24));
            const daysRemaining = Math.max(0, 10 - daysElapsed);

            if (daysElapsed <= 10) {
              followUpStatus = {
                isMatched: false,
                matchType: 'child',
                status: 'pending',
                label: `Pending Follow-up (Day ${daysElapsed + 1}/10)`,
                badgeText: `⏳ Day ${daysElapsed + 1}/10`,
                color: 'sky',
                daysElapsed,
                daysRemaining,
                matchedChassis: chassisVal,
                details: `Follow-up pending within 10-day window (Day ${daysElapsed + 1} of 10)`
              };
            } else {
              followUpStatus = {
                isMatched: false,
                matchType: 'child',
                status: 'overdue',
                label: `Overdue (${daysElapsed}d)`,
                badgeText: `✕ Overdue (${daysElapsed}d)`,
                color: 'rose',
                daysElapsed,
                matchedChassis: chassisVal,
                details: `Follow-up overdue by ${daysElapsed} days`
              };
            }
          }
        } else {
          followUpStatus = {
            isMatched: false,
            matchType: 'standalone',
            status: 'standalone',
            label: 'Main Record',
            badgeText: 'Main Record',
            color: 'slate',
            matchedChassis: chassisVal,
            details: `Standard inspection record for chassis "${chassisVal}"`
          };
        }
      } else {
        followUpStatus = {
          isMatched: false,
          matchType: 'none',
          status: 'no_chassis',
          label: 'No Chassis Specified',
          badgeText: '-',
          color: 'slate',
          details: 'No chassis number detected on this submission'
        };
      }

      return {
        ...responseObj,
        answers: respAnswers,
        responseRanks: toPlainObject(response.responseRanks),
        submissionMetadata: responseObj.submissionMetadata ? {
          ...responseObj.submissionMetadata,
          submittedAt: responseObj.submittedAt || responseObj.createdAt || responseObj.submissionMetadata.submittedAt
        } : null,
        submittedAt: responseObj.submittedAt || responseObj.createdAt || undefined,
        submittedBy: displaySubmittedBy, // Override with better display name
        review: reviewInfo,
        followUpStatus
      };
    });

    res.json({
      success: true,
      data: {
        responses: formattedResponses,
        form: {
          id: form.id,
          title: form.title,
          isParentForm,
          isChildForm,
          childFormCount: childFormIds.length,
          parentFormId: parentFormIdStr
        },
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalResponses: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get responses by form error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const exportResponses = async (req, res) => {
  try {
    const { formId } = req.params;
    const { format = 'json', status, includePartial = 'false', startDate, endDate } = req.query;

    // Verify form exists
    let formSearchQuery = { id: formId };

    // If not superadmin, check if form belongs to or is shared with this tenant
    // If not superadmin, check if form belongs to or is shared with this tenant
    if (req.user.role !== 'superadmin' && req.user.tenantId) {
      const tenantId = req.user.tenantId instanceof mongoose.Types.ObjectId
        ? req.user.tenantId
        : new mongoose.Types.ObjectId(req.user.tenantId);

      const tenantIdStr = tenantId.toString();

      formSearchQuery.$or = [
        { tenantId: tenantId },
        { sharedWithTenants: tenantId },
        { "chassisTenantAssignments.assignedTenants": tenantIdStr }
      ];
    }

    const form = await Form.findOne(formSearchQuery);
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Determine access level
    const userTenantIdStr = req.user.tenantId?.toString();
    const isSuperAdmin = req.user.role === 'superadmin';
    const isOwner = form.tenantId && form.tenantId.toString() === userTenantIdStr;
    const isShared = form.sharedWithTenants && form.sharedWithTenants.some(t => t.toString() === userTenantIdStr);
    const hasChassisShare = Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.some(
      a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr)
    );

    const query = { questionId: { $in: [form.id, form._id.toString()] } };

    // Apply tenant filtering
    if (req.user.role === 'inspector') {
      const userEmail = req.user.email || '';
      const userUsername = req.user.username || '';
      const userId = req.user._id;
      const userTenantId = req.user.tenantId;

      query.$or = [
        { createdBy: userId },
        { submittedBy: userEmail },
        { submittedBy: userUsername },
        { "submitterContact.email": userEmail },
        { tenantId: { $ne: userTenantId } }
      ];
    } else if (isOwner || isSuperAdmin) {
      Object.assign(query, req.tenantFilter);
    } else if (!isShared && !hasChassisShare) {
      Object.assign(query, req.tenantFilter);
    }

    // Filter out partial submissions unless explicitly requested
    if (includePartial !== 'true') {
      query.isSectionSubmit = { $ne: true };
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    if (startDate || endDate) {
      const dateFilterQuery = {};
      if (startDate) {
        const sDate = new Date(startDate);
        sDate.setUTCHours(0, 0, 0, 0);
        const sDateBuffer = new Date(sDate.getTime() - 6 * 3600 * 1000);
        dateFilterQuery.$gte = sDateBuffer;
      }
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setUTCHours(23, 59, 59, 999);
        const eDateBuffer = new Date(eDate.getTime() + 12 * 3600 * 1000);
        dateFilterQuery.$lte = eDateBuffer;
      }
      if (!query.$and) query.$and = [];
      query.$and.push({
        $or: [
          { createdAt: dateFilterQuery },
          { submittedAt: dateFilterQuery }
        ]
      });
    }

    let responses = await Response.find(query)
      .populate('assignedTo', 'username firstName lastName email')
      .populate('verifiedBy', 'username firstName lastName email')
      .sort({ createdAt: -1 });

    // Apply granular chassis filtering for chassis-shared users
    if (!isSuperAdmin && !isOwner && hasChassisShare && !isShared) {
      const myAssignedChassis = (form.chassisTenantAssignments || [])
        .filter(a => a.assignedTenants && a.assignedTenants.includes(userTenantIdStr))
        .map(a => a.chassisNumber)
        .filter(Boolean);

      if (myAssignedChassis.length > 0) {
        // Find the question ID that has type 'chassisNumber'
        const chassisQuestion = form.sections?.flatMap(s => s.questions || []).find(q => q.type === 'chassisNumber')
          || form.followUpQuestions?.find(q => q.type === 'chassisNumber');
        const chassisFieldId = chassisQuestion?.id || 'chassis_number';

        responses = responses.filter(r => {
          const rAnswers = r.answers instanceof Map ? Object.fromEntries(r.answers) : (r.answers || {});
          return myAssignedChassis.includes(rAnswers[chassisFieldId] || rAnswers['chassis_number']);
        });
      } else {
        responses = [];
      }
    }

    // Convert Map to Object for JSON serialization
    const formattedResponses = responses.map(response => ({
      ...response.toObject(),
      answers: response.answers ? Object.fromEntries(response.answers) : {},
      responseRanks: response.responseRanks ? Object.fromEntries(response.responseRanks) : {}
    }));

    if (format === 'json') {
      const filename = `${form.title}_responses.json`;
      const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
      const encodedFilename = encodeURIComponent(filename);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
      res.json({
        form: {
          id: form.id,
          title: form.title,
          description: form.description
        },
        responses: formattedResponses,
        exportedAt: new Date().toISOString(),
        totalCount: formattedResponses.length
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Unsupported export format. Currently only JSON is supported.'
      });
    }

  } catch (error) {
    console.error('Export responses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
export const getUnassignedResponses = async (req, res) => {
  try {
    const { tenantId, startDate, endDate, limit = 100 } = req.query;

    const query = {
      tenantId,
      assignedTo: { $exists: false }, // Not assigned
      status: 'pending'
    };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const responses = await Response.find(query)
      .sort({ createdAt: 1 }) // Oldest first
      .limit(parseInt(limit))
      .lean();

    // Format answers
    const formattedResponses = responses.map(r => ({
      ...r,
      answers: r.answers instanceof Map ? Object.fromEntries(r.answers) : r.answers
    }));

    const total = await Response.countDocuments(query);

    res.json({
      success: true,
      data: {
        responses: formattedResponses,
        total,
        hasMore: total > parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get unassigned responses error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
export const assignResponses = async (req, res) => {
  try {
    const { responseIds, adminId } = req.body;

    if (!Array.isArray(responseIds) || responseIds.length === 0 || !adminId) {
      return res.status(400).json({
        success: false,
        message: 'Response IDs and admin ID are required'
      });
    }

    const result = await Response.updateMany(
      {
        id: { $in: responseIds },
        assignedTo: { $exists: false }
      },
      {
        $set: {
          assignedTo: adminId,
          assignedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} responses assigned successfully`,
      data: { modifiedCount: result.modifiedCount }
    });
  } catch (error) {
    console.error('Assign responses error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
export const autoAssignResponse = async (req, res) => {
  try {
    const { responseId } = req.params;
    const { tenantId } = req.body;

    // Get all active admins/subadmins for this tenant
    const admins = await User.find({
      tenantId,
      role: { $in: ['admin', 'subadmin', 'inspector'] },
      isActive: true
    }).select('_id').lean();

    if (admins.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active admins available for assignment'
      });
    }

    // Get current assignment counts for round-robin
    const assignmentCounts = await Response.aggregate([
      {
        $match: {
          tenantId,
          assignedTo: { $ne: null },
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
        }
      },
      {
        $group: {
          _id: '$assignedTo',
          count: { $sum: 1 }
        }
      }
    ]);

    // Create map of adminId -> current load
    const loadMap = {};
    admins.forEach(admin => loadMap[admin._id.toString()] = 0);
    assignmentCounts.forEach(item => {
      loadMap[item._id.toString()] = item.count;
    });

    // Find admin with least load
    let selectedAdmin = admins[0];
    let minLoad = loadMap[selectedAdmin._id.toString()];

    admins.forEach(admin => {
      const load = loadMap[admin._id.toString()];
      if (load < minLoad) {
        minLoad = load;
        selectedAdmin = admin;
      }
    });

    // Assign the response
    const response = await Response.findOneAndUpdate(
      { id: responseId, assignedTo: { $exists: false } },
      {
        $set: {
          assignedTo: selectedAdmin._id,
          assignedAt: new Date()
        }
      },
      { new: true }
    );

    if (!response) {
      return res.status(404).json({
        success: false,
        message: 'Response not found or already assigned'
      });
    }

    res.json({
      success: true,
      message: 'Response assigned automatically',
      data: {
        responseId,
        assignedTo: selectedAdmin._id,
        adminLoad: loadMap
      }
    });
  } catch (error) {
    console.error('Auto-assign response error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const bulkUpdateBiwReview = async (req, res) => {
  try {
    const { ids, status } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of response IDs'
      });
    }

    const allowedStatuses = ['Accepted', 'Rejected', 'Reworked', null];
    if (status !== undefined && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid biwReview status. Must be one of: Accepted, Rejected, Reworked, or null`
      });
    }

    // Find all target responses matching the IDs, then keep only the ones
    // the acting user actually has tenant access to (owner tenant, shared
    // tenant, chassis share, or superadmin) — a raw req.tenantFilter match
    // would silently exclude every response on a form merely shared with
    // this user's tenant, since Response.tenantId always reflects the form
    // OWNER's tenant, not the acting user's.
    const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const findQuery = {
      $or: [
        { id: { $in: ids } },
        { _id: { $in: objectIds } }
      ]
    };
    const candidateResponses = await Response.find(findQuery);
    const accessFlags = await Promise.all(
      candidateResponses.map((r) => canAccessResponseTenant(req, r)),
    );
    const responses = candidateResponses.filter((_, idx) => accessFlags[idx]);

    if (responses.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No matching responses found'
      });
    }

    const userEmail = req.user.email || '';
    const userUsername = req.user.username || '';
    const userIdStr = req.user._id ? req.user._id.toString() : '';
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';

    let updatedCount = 0;
    let skippedCount = 0;

    for (const response of responses) {
      // Check if user is trying to review their own submission (mirror single review logic)
      const originalCreatedBy = response.createdBy;
      const originalSubmittedBy = response.submittedBy;
      const originalSubmitterContact = response.submitterContact;
      const creatorIdStr = originalCreatedBy ? originalCreatedBy.toString() : '';
      const isExcelImport = originalSubmittedBy === 'Excel Import';

      const isSubmitter =
        !isAdmin &&
        !isExcelImport &&
        (
          originalSubmittedBy === userEmail ||
          originalSubmittedBy === userUsername ||
          (originalSubmitterContact && originalSubmitterContact.email === userEmail) ||
          (creatorIdStr && creatorIdStr === userIdStr)
        );

      if (isSubmitter && status !== null) {
        skippedCount++;
        continue;
      }

      if (status === null) {
        response.biwReview = undefined;
      } else {
        response.biwReview = {
          status,
          reviewedBy: req.user._id,
          reviewedByName: userUsername || userEmail || 'Reviewer',
          reviewedAt: new Date()
        };
      }

      await response.save();
      updatedCount++;
    }

    // Record in history timeline
    recordImportHistory({
      tenantId: req.user?.tenantId,
      userId: req.user?._id,
      userName: req.user?.username || req.user?.name || req.user?.email || 'Reviewer',
      userEmail: req.user?.email || '',
      userRole: req.user?.role || 'admin',
      actionType: 'BULK_REVIEW_UPDATE',
      actionTitle: 'Bulk BIW Review Update',
      formId: req.body?.formId || '',
      formTitle: 'BIW Review',
      batchId: `review-${Date.now()}`,
      dataCount: {
        total: responses.length,
        success: updatedCount,
        failed: skippedCount
      },
      details: {
        notes: `Updated BIW status to "${status || 'Cleared'}" for ${updatedCount} responses (${skippedCount} skipped)`
      },
      status: 'success'
    }).catch(err => console.error('[IMPORT HISTORY LOG ERROR]', err));

    res.json({
      success: true,
      message: `Bulk BIW review update completed: ${updatedCount} updated, ${skippedCount} skipped.`,
      data: {
        updatedCount,
        skippedCount
      }
    });

  } catch (error) {
    console.error('Bulk update BIW review error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};