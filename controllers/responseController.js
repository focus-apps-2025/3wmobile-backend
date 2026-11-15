// controllers/responseController.js
import mongoose from 'mongoose';
import Response from '../models/Response.js';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';
import { v4 as uuidv4 } from 'uuid';
import { collectSubmissionMetadata } from '../services/locationService.js';
import {
  emitResponseCreated,
  emitResponseUpdated,
  emitResponseDeleted,
  emitImageProgress,
  emitBatchImported,
} from '../socket/socketHandler.js';
import { processResponseImages, isGoogleDriveUrl } from '../services/googleDriveService.js';
import FormInvite from '../models/FormInvite.js';
import ChatMessage from '../models/ChatMessage.js';
import { recordImportHistory } from './importHistoryController.js';
import { invalidateCache } from '../utils/cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory caches
// ─────────────────────────────────────────────────────────────────────────────
const suggestionsMemoryCache = new Map();
const formMetaCache = new Map();
const tenantSlugCache = new Map();

// Unified rank/attempts cache (replaces the old formAttemptsMemoryCache).
// Key: `${formId}:${questionId}:${answerLower}` — 45 second TTL.
const rankCache = new Map();
const RANK_CACHE_TTL_MS = 45 * 1000;

export const clearRankCache = (formId) => {
  if (!formId) {
    rankCache.clear();
    return;
  }
  const prefix = `${String(formId)}:`;
  for (const key of rankCache.keys()) {
    if (key.startsWith(prefix)) rankCache.delete(key);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared/Linked-Tenant Response Access Helper
// ─────────────────────────────────────────────────────────────────────────────
// Response docs are stamped with the FORM OWNER's tenantId, never the
// submitter's. This helper resolves the form first, then permits access when
// the acting user is owner / shared / chassis-assigned / creator / same-tenant.
const extractResponseChassisCandidates = (response) => {
  const candidates = new Set();
  if (response.chassisNumber) candidates.add(String(response.chassisNumber).trim().toLowerCase());
  if (response.systemChassisNumber) candidates.add(String(response.systemChassisNumber).trim().toLowerCase());

  let answerObj = response.answers;
  if (answerObj) {
    if (typeof answerObj.toJSON === 'function') {
      answerObj = answerObj.toJSON();
    } else if (answerObj instanceof Map) {
      answerObj = Object.fromEntries(answerObj);
    }
    if (typeof answerObj === 'object') {
      const chassisKeyPatterns = ['chassis', 'vin', 'vehicle', 'serial', 'selected'];
      for (const [key, val] of Object.entries(answerObj)) {
        if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
          const strVal = String(val).trim().toLowerCase();
          if (!strVal) continue;
          const kLower = key.toLowerCase();
          if (chassisKeyPatterns.some((p) => kLower.includes(p))) {
            candidates.add(strVal);
          }
        }
      }
    }
  }
  return Array.from(candidates);
};

const canAccessResponseTenant = async (req, response) => {
  if (!response) return false;
  if (req.user?.role === 'superadmin') return true;

  const userTenantIdStr = req.user?.tenantId ? req.user.tenantId.toString() : null;
  const responseTenantIdStr = response.tenantId ? response.tenantId.toString() : null;
  const matchesResponseTenant = responseTenantIdStr && responseTenantIdStr === userTenantIdStr;
  const matchesCreator =
    req.user?._id && response.createdBy && String(response.createdBy) === String(req.user._id);

  if (matchesResponseTenant || matchesCreator) return true;

  const targetFormId = response.questionId || response.formId;
  const or_conditions = [{ id: targetFormId }];
  if (mongoose.Types.ObjectId.isValid(targetFormId)) {
    or_conditions.push({ _id: targetFormId });
  }
  if (response.formId && response.formId !== targetFormId) {
    or_conditions.push({ id: response.formId });
    if (mongoose.Types.ObjectId.isValid(response.formId)) {
      or_conditions.push({ _id: response.formId });
    }
  }

  const form = await Form.findOne({ $or: or_conditions })
    .select('tenantId sharedWithTenants chassisTenantAssignments parentFormId parentForm')
    .lean();

  const isOwnerTenant = form?.tenantId && form.tenantId.toString() === userTenantIdStr;
  const isSharedTenant =
    form?.sharedWithTenants &&
    form.sharedWithTenants.some((t) => String(t?._id || t?.id || t) === userTenantIdStr);

  let matchesAssignedChassis = false;
  if (Array.isArray(form?.chassisTenantAssignments) && userTenantIdStr) {
    const myAssignedChassis = form.chassisTenantAssignments
      .filter((a) =>
        a.assignedTenants &&
        a.assignedTenants.some((t) => String(t?._id || t?.id || t) === userTenantIdStr)
      )
      .map((a) => String(a.chassisNumber || '').trim().toLowerCase())
      .filter(Boolean);

    if (myAssignedChassis.length > 0) {
      const respChassisCandidates = extractResponseChassisCandidates(response);
      if (respChassisCandidates.some((c) => myAssignedChassis.includes(c))) {
        matchesAssignedChassis = true;
      }
    }
  }

  let matchesParentFormAccess = false;
  if (!isOwnerTenant && !isSharedTenant && !matchesAssignedChassis && userTenantIdStr) {
    const formIdentifiers = [form?.id, form?._id ? form._id.toString() : null, targetFormId].filter(Boolean);
    const parentQuery = [
      { 'childForms.formId': { $in: formIdentifiers } },
      { 'childForms.id': { $in: formIdentifiers } },
    ];
    const parentId = form?.parentFormId || form?.parentForm?.id || form?.parentForm?._id;
    if (parentId) {
      if (mongoose.Types.ObjectId.isValid(parentId)) parentQuery.push({ _id: parentId });
      parentQuery.push({ id: parentId });
    }

    const parentFormDoc = await Form.findOne({ $or: parentQuery })
      .select('tenantId sharedWithTenants chassisTenantAssignments')
      .lean();

    if (parentFormDoc) {
      const isParentOwner =
        parentFormDoc.tenantId && parentFormDoc.tenantId.toString() === userTenantIdStr;
      const isParentShared =
        Array.isArray(parentFormDoc.sharedWithTenants) &&
        parentFormDoc.sharedWithTenants.some((t) => String(t?._id || t?.id || t) === userTenantIdStr);
      const isParentAssigned =
        Array.isArray(parentFormDoc.chassisTenantAssignments) &&
        (() => {
          const myParentAssigned = parentFormDoc.chassisTenantAssignments
            .filter((a) =>
              a.assignedTenants &&
              a.assignedTenants.some((t) => String(t?._id || t?.id || t) === userTenantIdStr)
            )
            .map((a) => String(a.chassisNumber || '').trim().toLowerCase())
            .filter(Boolean);
          if (myParentAssigned.length === 0) return false;
          const respChassisCandidates = extractResponseChassisCandidates(response);
          return respChassisCandidates.some((c) => myParentAssigned.includes(c));
        })();
      matchesParentFormAccess = Boolean(isParentOwner || isParentShared || isParentAssigned);
    }
  }

  let matchesChildFormAccess = false;
  if (
    !isOwnerTenant &&
    !isSharedTenant &&
    !matchesAssignedChassis &&
    !matchesParentFormAccess &&
    userTenantIdStr &&
    Array.isArray(form?.childForms) &&
    form.childForms.length > 0
  ) {
    const childIds = form.childForms.map((cf) => cf.formId || cf.id).filter(Boolean);
    const childFormDocs = await Form.find({
      $or: [
        { id: { $in: childIds } },
        { _id: { $in: childIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) } },
      ],
    })
      .select('tenantId sharedWithTenants')
      .lean();
    matchesChildFormAccess = childFormDocs.some(
      (cf) =>
        (cf.tenantId && cf.tenantId.toString() === userTenantIdStr) ||
        (Array.isArray(cf.sharedWithTenants) &&
          cf.sharedWithTenants.some((t) => String(t?._id || t?.id || t) === userTenantIdStr))
    );
  }

  return Boolean(
    isOwnerTenant ||
    isSharedTenant ||
    matchesAssignedChassis ||
    matchesParentFormAccess ||
    matchesChildFormAccess ||
    matchesResponseTenant
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Inspector Visibility Filter
// ─────────────────────────────────────────────────────────────────────────────
export const buildInspectorVisibilityFilter = (req, dispatchedOnly = false) => {
  const user = req.user || {};
  const isSuperAdmin = user.role === 'superadmin' || user.role === 'admin';
  const tenantId = user.tenantId;

  if (isSuperAdmin) return {};

  const ownBranches = [
    { createdBy: user._id },
    user.email ? { submittedBy: user.email } : null,
    user.username ? { submittedBy: user.username } : null,
    user.email ? { 'submitterContact.email': user.email } : null,
  ].filter(Boolean);

  const baseOr = [
    ...ownBranches,
    tenantId ? { tenantId } : null,
    tenantId ? { tenantId: { $ne: tenantId }, isDispatched: true } : null,
  ].filter(Boolean);

  if (dispatchedOnly === true || dispatchedOnly === 'true') {
    return {
      $and: [{ $or: baseOr }, { $or: [...ownBranches, { isDispatched: true }] }],
    };
  }

  return { $or: baseOr };
};

// ─────────────────────────────────────────────────────────────────────────────
// Robust Date Parser for Excel Imports
// ─────────────────────────────────────────────────────────────────────────────
function parseExcelDateBackend(value) {
  if (!value && value !== 0) return undefined;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return undefined;
    const fullYear = value.getFullYear();
    if (fullYear >= 30000 && fullYear <= 100000) {
      return parseExcelDateBackend(fullYear);
    }
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

    const plusYearMatch = trimmed.match(/^\+0*(\d{5,6})/);
    if (plusYearMatch) {
      const serial = parseInt(plusYearMatch[1], 10);
      if (serial >= 30000 && serial <= 100000) return parseExcelDateBackend(serial);
    }

    const fiveDigitYearMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{5,6})/);
    if (fiveDigitYearMatch) {
      const serial = parseInt(fiveDigitYearMatch[3], 10);
      if (serial >= 30000 && serial <= 100000) return parseExcelDateBackend(serial);
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

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────
const extractAnswerString = (ans) => {
  if (ans === null || ans === undefined) return '';
  if (typeof ans === 'object') {
    if (ans.chassisNumber !== undefined && ans.chassisNumber !== null) return String(ans.chassisNumber).trim();
    if (ans.value !== undefined && ans.value !== null) return String(ans.value).trim();
    if (ans.text !== undefined && ans.text !== null) return String(ans.text).trim();
    if (ans.chassis !== undefined && ans.chassis !== null) return String(ans.chassis).trim();
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
          { _id: mongoose.Types.ObjectId.isValid(pStr) ? new mongoose.Types.ObjectId(pStr) : null },
        ].filter(Boolean),
      }).lean();
      if (parentForm) {
        relatedForms.push(parentForm);
        if (parentForm.id) formIds.push(parentForm.id);
        if (parentForm._id) formIds.push(parentForm._id.toString());
        if (Array.isArray(parentForm.childForms)) {
          parentForm.childForms.forEach((cf) => {
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
    const parentsByChild = await Form.find({ 'childForms.formId': { $in: targetIds } }).lean();
    parentsByChild.forEach((pf) => {
      relatedForms.push(pf);
      if (pf.id) formIds.push(pf.id);
      if (pf._id) formIds.push(pf._id.toString());
      if (Array.isArray(pf.childForms)) {
        pf.childForms.forEach((cf) => {
          if (cf.formId) formIds.push(cf.formId);
        });
      }
    });
  } catch (err) {
    console.warn('Error checking parentsByChild in getRelatedFormsAndIds:', err);
  }

  if (Array.isArray(form.childForms)) {
    form.childForms.forEach((cf) => {
      if (cf.formId) formIds.push(cf.formId);
    });
  }

  return { formIds: Array.from(new Set(formIds)), relatedForms };
};

const getRelatedFormIds = async (form, baseFormId) => {
  const { formIds } = await getRelatedFormsAndIds(form, baseFormId);
  return formIds;
};

const getThisFormIds = (form, baseFormId) => {
  return Array.from(
    new Set([form.id, form._id ? form._id.toString() : null, baseFormId].filter(Boolean))
  );
};

const getThisFormExtraQuestionIds = (form) => {
  const extraQIds = [];
  const collectQ = (qs) => {
    (qs || []).forEach((q) => {
      if (q.id) extraQIds.push(q.id);
      if (q._id) extraQIds.push(q._id.toString());
      if (q.text) extraQIds.push(q.text);
      if (q.followUpQuestions) collectQ(q.followUpQuestions);
    });
  };
  (form.sections || []).forEach((s) => collectQ(s.questions));
  collectQ(form.followUpQuestions);
  return Array.from(new Set(extraQIds));
};

const buildChassisOrConditions = (questionId, trackingQId, strAnswer, extraQuestionIds = []) => {
  const trimmed = String(strAnswer || '').trim();
  if (!trimmed) return [];
  const possibleStrings = Array.from(
    new Set([
      trimmed,
      trimmed.toLowerCase(),
      trimmed.toUpperCase(),
      trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase(),
    ])
  );

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

  (extraQuestionIds || []).forEach((qId) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Chassis range bounds / expansion
// ─────────────────────────────────────────────────────────────────────────────
export const extractRangeBounds = (val) => {
  if (!val) return null;
  if (typeof val === 'object') {
    if (val.start !== undefined && val.end !== undefined && (val.start !== '' || val.end !== '')) {
      return { start: String(val.start).trim(), end: String(val.end).trim() };
    }
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && (parsed.start !== undefined || parsed.end !== undefined)) {
          return { start: String(parsed.start ?? '').trim(), end: String(parsed.end ?? '').trim() };
        }
      } catch { }
    }
    if (trimmed.includes(' - ')) {
      const parts = trimmed.split(' - ');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { start: parts[0].trim(), end: parts[1].trim() };
      }
    }
    if (trimmed.toLowerCase().includes(' to ')) {
      const parts = trimmed.split(/\s+to\s+/i);
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { start: parts[0].trim(), end: parts[1].trim() };
      }
    }
  }
  return null;
};

export const expandChassisRange = (startStr, endStr, maxLimit = 200) => {
  const start = String(startStr || '').trim();
  const end = String(endStr || '').trim();
  if (!start && !end) return [];
  if (!start) return [end];
  if (!end) return [start];
  if (start === end) return [start];

  // Pure numeric
  if (/^\d+$/.test(start) && /^\d+$/.test(end)) {
    const n1 = parseInt(start, 10);
    const n2 = parseInt(end, 10);
    const low = Math.min(n1, n2);
    const high = Math.max(n1, n2);
    const count = Math.min(high - low + 1, maxLimit);
    const padLen = Math.max(start.length, end.length);
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(String(high - i).padStart(padLen, '0'));
    }
    return list;
  }

  // Prefix + numeric suffix
  const startMatch = start.match(/^(.*?)(\d+)$/);
  const endMatch = end.match(/^(.*?)(\d+)$/);
  if (startMatch && endMatch && startMatch[1] === endMatch[1]) {
    const prefix = startMatch[1];
    const n1 = parseInt(startMatch[2], 10);
    const n2 = parseInt(endMatch[2], 10);
    const low = Math.min(n1, n2);
    const high = Math.max(n1, n2);
    const count = Math.min(high - low + 1, maxLimit);
    const padLen = Math.max(startMatch[2].length, endMatch[2].length);
    const list = [];
    for (let i = 0; i < count; i++) {
      const val = String(high - i).padStart(padLen, '0');
      list.push(`${prefix}${val}`);
    }
    return list;
  }

  return [end, start];
};

function formatTimeDuration(seconds) {
  if (!seconds || seconds < 0) return '0 seconds';
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    if (remainingSeconds === 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared sub-status inference (used by getRank / suggestions)
// ─────────────────────────────────────────────────────────────────────────────
const inferSubStatusFromAnswers = (answersObj) => {
  let hasRework = false;
  let hasReject = false;
  for (const val of Object.values(answersObj || {})) {
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
  return { hasRework, hasReject };
};

const sanitizeAnswersForClient = (answersObj) => {
  const out = {};
  for (const [k, v] of Object.entries(answersObj || {})) {
    if (typeof v === 'string') {
      out[k] = v.startsWith('data:image') ? '' : v;
    } else if (v && typeof v === 'object') {
      const copy = { ...v };
      if (typeof copy.evidenceUrl === 'string' && copy.evidenceUrl.startsWith('data:image')) {
        copy.evidenceUrl = '';
      }
      out[k] = copy;
    } else {
      out[k] = v;
    }
  }
  return out;
};

// ═════════════════════════════════════════════════════════════════════════════
// createResponse
// ═════════════════════════════════════════════════════════════════════════════
export const createResponse = async (req, res) => {
  try {
    console.log('[CREATE RESPONSE] === START ===');
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
      completedAt,
    } = req.body;
    const { tenantSlug, formId: paramFormId } = req.params;
    const questionId = paramFormId || bodyFormId;

    if (!questionId) {
      return res.status(400).json({ success: false, message: 'Form ID is required' });
    }

    let form;
    let submissionTimeSpent = 0;
    let formSession = null;
    let actualStartedAt = startedAt ? new Date(startedAt) : null;
    let actualCompletedAt = completedAt ? new Date(completedAt) : new Date();

    if (actualStartedAt) {
      submissionTimeSpent = Math.floor((actualCompletedAt - actualStartedAt) / 1000);
    }

    // ── Session timing ──
    if (sessionId) {
      try {
        formSession = await mongoose.model('FormSession').findOne({ sessionId });
        if (formSession) {
          if (formSession.startedAt) {
            actualStartedAt = formSession.startedAt;
            actualCompletedAt = new Date();
            submissionTimeSpent = Math.floor((actualCompletedAt - formSession.startedAt) / 1000);
          }
          if (!isSectionSubmit) {
            formSession.completedAt = actualCompletedAt;
            formSession.timeSpent = submissionTimeSpent;
            formSession.status = 'completed';
            formSession.answers = answers;
            await formSession.save();
          } else {
            formSession.lastActivityAt = actualCompletedAt;
            await formSession.save();
          }
        }
      } catch (err) {
        console.error('Error finding FormSession:', err);
      }
    } else if (req.formSessionId) {
      try {
        formSession = await mongoose.model('FormSession').findOne({ sessionId: req.formSessionId });
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

    if (!formSession && !isSectionSubmit) {
      try {
        const recentSession = await mongoose
          .model('FormSession')
          .findOne({
            formId: questionId,
            userId: req.user?._id || null,
            status: 'in-progress',
            startedAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
          })
          .sort({ startedAt: -1 });

        if (recentSession) {
          submissionTimeSpent = Math.floor((new Date() - recentSession.startedAt) / 1000);
          recentSession.completedAt = new Date();
          recentSession.timeSpent = submissionTimeSpent;
          recentSession.status = 'completed';
          recentSession.answers = answers;
          await recentSession.save();
          formSession = recentSession;
        }
      } catch (err) {
        console.error('Error finding recent session:', err);
      }
    }

    // ── Form lookup ──
    const searchConditions = [{ id: questionId }];
    if (mongoose.Types.ObjectId.isValid(questionId)) {
      searchConditions.push({ _id: new mongoose.Types.ObjectId(String(questionId)) }, { _id: questionId });
    }
    form = await Form.findOne({ $or: searchConditions });

    if (!form && tenantSlug) {
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });
      if (tenant) form = await Form.findOne({ $or: searchConditions, tenantId: tenant._id });
    }
    if (!form) {
      return res.status(404).json({ success: false, message: `Form not found with ID: ${questionId}` });
    }

    // ── Invite ──
    let inviteStatus = null;
    let inviteObj = null;
    if (inviteId) {
      inviteObj = await FormInvite.findOne({ formId: questionId, inviteId });
      if (inviteObj) {
        if (!isSectionSubmit) {
          inviteObj.status = 'responded';
          inviteObj.respondedAt = new Date();
          await inviteObj.save().catch((e) => console.error('[INVITE] Error saving:', e));
          inviteStatus = 'responded';
        }
      }
    }

    // ── Submission metadata ──
    const submissionMetadata = await collectSubmissionMetadata(req, {
      includeLocation: form.locationEnabled !== false,
    });
    if (bodyMetadata && bodyMetadata.source) {
      submissionMetadata.source = bodyMetadata.source;
    } else if (inviteId && inviteObj) {
      if (inviteObj.notificationChannels && inviteObj.notificationChannels.length > 0) {
        submissionMetadata.source = inviteObj.notificationChannels[0];
      } else if (inviteObj.phone && !inviteObj.email) {
        submissionMetadata.source = 'sms';
      } else if (inviteObj.email) {
        submissionMetadata.source = 'email';
      } else {
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
        capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
      };
    }

    // ── Collect questions ──
    const collectAllQuestions = (questions, result = []) => {
      if (!Array.isArray(questions)) return result;
      questions.forEach((q) => {
        result.push(q);
        if (Array.isArray(q.followUpQuestions)) collectAllQuestions(q.followUpQuestions, result);
      });
      return result;
    };

    const allQuestions = [];
    (form.sections || []).forEach((s) => collectAllQuestions(s.questions, allQuestions));
    collectAllQuestions(form.followUpQuestions, allQuestions);

    // ── Score ──
    let correct = 0;
    let total = 0;
    allQuestions.forEach((question) => {
      if (question.type === 'yesNoNA') {
        total++;
        const answer = answers[question.id];
        if (answer && String(answer).toLowerCase() === 'yes') correct++;
      } else {
        const hasCorrectAnswer =
          question.correctAnswer || (question.correctAnswers && question.correctAnswers.length > 0);
        if (hasCorrectAnswer) {
          total++;
          const answer = answers[question.id];
          let isCorrect = false;
          if (question.correctAnswers && question.correctAnswers.length > 0) {
            if (Array.isArray(answer)) {
              const na = answer.map((a) => String(a).toLowerCase());
              const nc = question.correctAnswers.map((a) => String(a).toLowerCase());
              isCorrect = na.length === nc.length && na.every((a) => nc.includes(a));
            } else {
              isCorrect = question.correctAnswers.map((a) => String(a).toLowerCase()).includes(String(answer).toLowerCase());
            }
          } else if (question.correctAnswer) {
            if (Array.isArray(answer)) {
              isCorrect = answer.some((a) => String(a).toLowerCase() === String(question.correctAnswer).toLowerCase());
            } else {
              isCorrect = String(answer).toLowerCase() === String(question.correctAnswer).toLowerCase();
            }
          }
          if (isCorrect) correct++;
        }
      }
    });

    // ── Rank calc ──
    const responseRanks = {};
    const formObj = form.toObject();
    const allQs = [];
    const collectFromQuestions = (questions) => {
      if (!Array.isArray(questions)) return;
      questions.forEach((q) => {
        allQs.push(q);
        if (Array.isArray(q.followUpQuestions)) collectFromQuestions(q.followUpQuestions);
      });
    };
    (formObj.sections || []).forEach((s) => collectFromQuestions(s.questions));
    collectFromQuestions(formObj.followUpQuestions);

    const processedQIds = new Set();
    const trackingQuestions = allQs.filter((q) => {
      const qId = q.id;
      if (!qId || processedQIds.has(qId)) return false;
      const isTracking =
        q.trackResponseRank === true ||
        q.trackResponseRank === 'true' ||
        q.trackResponseQuestion === true ||
        q.trackResponseQuestion === 'true';
      if (isTracking) processedQIds.add(qId);
      return isTracking;
    });

    if (trackingQuestions.length > 0) {
      const formIds = getThisFormIds(form, questionId);
      const extraQIds = getThisFormExtraQuestionIds(form);
      const rankPromises = trackingQuestions.map(async (question) => {
        const qId = question.id;
        const trackingQId = `${qId}_tracking`;
        const rawAns = answers[qId] !== undefined ? answers[qId] : answers[trackingQId];
        const strAnswer = extractAnswerString(rawAns);
        if (strAnswer === '') return;
        const orConditions = buildChassisOrConditions(qId, trackingQId, strAnswer, extraQIds);
        const query = {
          $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }],
          $and: [{ $or: orConditions }],
          isSectionSubmit: { $ne: true },
        };
        try {
          const count = await Response.countDocuments(query);
          responseRanks[qId] = count + 1;
        } catch (countError) {
          console.error(`[RANK ERROR] Failed to count for question ${qId}:`, countError);
        }
      });
      await Promise.all(rankPromises);
    }

    // ── Display name ──
    let displayName = 'Anonymous';
    if (req.body.submittedBy && req.body.submittedBy !== 'Anonymous') {
      displayName = req.body.submittedBy;
    } else if (req.user) {
      if (req.user.firstName || req.user.lastName) {
        displayName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
      }
      if (displayName === '' && req.user.username) displayName = req.user.username;
      if (displayName === '' && req.user.email) displayName = req.user.email;
    }

    // ── Chassis extraction ──
    let chassisVal = extractAnswerString(
      answers?.chassis_number ||
      answers?.selected_chassis ||
      answers?.selectedChassis ||
      answers?.chassisNumber ||
      answers?.id_number ||
      answers?.idNumber ||
      answers?.['ID number'] ||
      answers?.['Chassis / VIN'] ||
      answers?.['Chassis No'] ||
      answers?.['CHASSIS NUMBER'] ||
      req.body.chassisNumber
    );

    const configuredFormChassis = (form?.chassisNumbers || [])
      .map((c) => (typeof c === 'string' ? c : c.chassisNumber || c.name))
      .filter(Boolean);

    if (configuredFormChassis.length > 0) {
      if (chassisVal && !configuredFormChassis.includes(chassisVal)) {
        const matchingAnswer = Object.values(answers || {}).find(
          (v) => typeof v === 'string' && configuredFormChassis.includes(v.trim())
        );
        if (matchingAnswer) {
          chassisVal = typeof matchingAnswer === 'string' ? matchingAnswer.trim() : matchingAnswer;
        } else if (configuredFormChassis.length === 1) {
          chassisVal = configuredFormChassis[0];
        }
      } else if (!chassisVal && configuredFormChassis.length === 1) {
        chassisVal = configuredFormChassis[0];
      }
    } else if (!chassisVal) {
      for (const q of allQuestions) {
        if (
          q.trackResponseRank ||
          q.type === 'chassisNumber' ||
          (q.text && q.text.toLowerCase().includes('chassis') && !q.text.toLowerCase().includes('zone'))
        ) {
          const qVal = extractAnswerString(answers?.[q.id] || answers?.[`${q.id}_tracking`]);
          if (qVal) {
            chassisVal = qVal;
            break;
          }
        }
      }
    }
    if (chassisVal && answers && !answers.chassis_number) {
      answers.chassis_number = chassisVal;
    }

    // ── Range detection ──
    let detectedRange = null;
    let rangeQuestionKey = null;
    if (answers && typeof answers === 'object') {
      const priorityKeys = [
        'chassis_number', 'chassisNumber', 'ID number', 'id_number', 'idNumber',
        'selected_chassis', 'selectedChassis', 'Identification Number', 'identification_number',
      ];
      for (const pk of priorityKeys) {
        if (answers[pk] !== undefined) {
          const r = extractRangeBounds(answers[pk]);
          if (r && r.start && r.end) {
            detectedRange = r;
            rangeQuestionKey = pk;
            break;
          }
        }
      }
      if (!detectedRange) {
        for (const q of allQuestions) {
          const rawQVal =
            answers[q.id] !== undefined
              ? answers[q.id]
              : answers[q.text] !== undefined
                ? answers[q.text]
                : answers[`${q.id}_tracking`];
          const r = extractRangeBounds(rawQVal);
          if (r && r.start && r.end) {
            detectedRange = r;
            rangeQuestionKey = q.id;
            break;
          }
        }
      }
      if (!detectedRange) {
        for (const [key, val] of Object.entries(answers)) {
          const r = extractRangeBounds(val);
          if (r && r.start && r.end) {
            detectedRange = r;
            rangeQuestionKey = key;
            break;
          }
        }
      }
    }
    if (!detectedRange && chassisVal) {
      detectedRange = extractRangeBounds(chassisVal);
    }

    let chassisRangeList = [];
    if (detectedRange && detectedRange.start && detectedRange.end) {
      chassisRangeList = expandChassisRange(detectedRange.start, detectedRange.end);
      if (chassisRangeList.length > 0) {
        if (!configuredFormChassis.length || !configuredFormChassis.includes(chassisVal)) {
          chassisVal = chassisRangeList[0];
          if (answers) answers.chassis_number = chassisVal;
        }
      }
    }

    // ── Parent auto-link ──
    let resolvedParentResponseId = parentResponseId;
    if (!resolvedParentResponseId && form?.parentFormId && chassisVal) {
      try {
        const parentConditions = [{ id: form.parentFormId }];
        if (mongoose.Types.ObjectId.isValid(form.parentFormId)) {
          parentConditions.push({ _id: form.parentFormId });
        }
        const parentFormDoc = await Form.findOne({ $or: parentConditions }).lean();
        const parentFormIds = [form.parentFormId.toString()].concat(
          parentFormDoc ? [parentFormDoc.id, parentFormDoc._id?.toString()].filter(Boolean) : []
        );
        const orConditions = [
          { chassisNumber: chassisVal },
          { 'answers.chassis_number': chassisVal },
          { 'answers.chassisNumber': chassisVal },
          { 'answers.id_number': chassisVal },
          { 'answers.idNumber': chassisVal },
          { 'answers.Identification Number': chassisVal },
          { 'answers.identification_number': chassisVal },
          { 'answers.identificationNumber': chassisVal },
          { 'answers.ID number': chassisVal },
          { 'answers.Chassis / VIN': chassisVal },
          { 'answers.Chassis No': chassisVal },
          { 'answers.CHASSIS NUMBER': chassisVal },
        ];
        if (parentFormDoc) {
          (parentFormDoc.sections || []).forEach((s) =>
            (s.questions || []).forEach((q) => {
              orConditions.push({ [`answers.${q.id}`]: chassisVal });
              if (q.text) orConditions.push({ [`answers.${q.text}`]: chassisVal });
            })
          );
          (parentFormDoc.followUpQuestions || []).forEach((q) => {
            orConditions.push({ [`answers.${q.id}`]: chassisVal });
            if (q.text) orConditions.push({ [`answers.${q.text}`]: chassisVal });
          });
        }
        const parentResp = await Response.findOne({
          questionId: { $in: parentFormIds },
          isSectionSubmit: { $ne: true },
          $or: orConditions,
        })
          .sort({ createdAt: -1 })
          .lean();
        if (parentResp) {
          resolvedParentResponseId = parentResp.id || (parentResp._id ? parentResp._id.toString() : null);
        }
      } catch (pmErr) {
        console.warn('[CREATE RESPONSE] Error auto-linking parent response:', pmErr);
      }
    }

    // ── Duplicate guards ──
    const isDuplicateConfirmed = req.body?.confirmDuplicate === true || req.body?.confirmDuplicateChassis === true;
    const targetSessionId = isDuplicateConfirmed ? null : sessionId || formSession?.sessionId;
    if (targetSessionId && !isSectionSubmit) {
      const existingSessionResponse = await Response.findOne({
        questionId,
        $or: [{ sessionId: targetSessionId }, { 'submissionMetadata.sessionId': targetSessionId }],
      });
      if (existingSessionResponse) {
        const existingAnswers =
          existingSessionResponse.answers instanceof Map
            ? Object.fromEntries(existingSessionResponse.answers)
            : existingSessionResponse.answers;
        return res.status(200).json({
          success: true,
          message: 'Response already submitted successfully',
          data: { response: { ...existingSessionResponse.toObject(), answers: existingAnswers } },
        });
      }
    }

    // Rapid duplicate (50s) guard from file 2
    if (!isDuplicateConfirmed && chassisVal && !isSectionSubmit) {
      const recentWindow = new Date(Date.now() - 50 * 1000);
      const duplicateFilter = {
        questionId,
        chassisNumber: chassisVal,
        createdAt: { $gte: recentWindow },
        isSectionSubmit: { $ne: true },
      };
      if (req.user?._id) duplicateFilter.createdBy = req.user._id;
      else if (displayName && displayName !== 'Anonymous') duplicateFilter.submittedBy = displayName;

      const recentDuplicate = await Response.findOne(duplicateFilter);
      if (recentDuplicate) {
        const dupAnswers =
          recentDuplicate.answers instanceof Map
            ? Object.fromEntries(recentDuplicate.answers)
            : recentDuplicate.answers;
        return res.status(200).json({
          success: true,
          message: 'Response already submitted successfully',
          data: { response: { ...recentDuplicate.toObject(), answers: dupAnswers } },
        });
      }
    }

    const responseData = {
      id: uuidv4(),
      questionId,
      answers: new Map(Object.entries(answers || {})),
      responseRanks: new Map(Object.entries(responseRanks || {})),
      driveBackupUrls: {},
      imageProcessing: {
        totalImages: 0, processedImages: 0, driveBackups: 0,
        folderStructure: null, processingTime: 0, status: 'completed',
      },
      parentResponseId: resolvedParentResponseId || undefined,
      chassisNumber: chassisVal || undefined,
      submittedBy: displayName,
      submitterContact: {
        email: req.body.submitterContact?.email || req.user?.email,
        phone: req.body.submitterContact?.phone,
      },
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
        sectionTimings: formSession?.sectionTimings,
      },
      status: 'pending',
      createdBy: req.user?._id || null,
      isSectionSubmit: !!isSectionSubmit,
      sectionIndex: sectionIndex || null,
      tenantId: form.tenantId,
      score: { correct, total },
      inviteId: inviteId || null,
    };

    let primaryResponse = null;
    let createdResponses = [];
    let rangeBatchId = null;

    if (chassisRangeList && chassisRangeList.length > 1) {
      rangeBatchId = `range-${Date.now()}`;
      const baseNow = Date.now();

      let parentFormDoc = null;
      let parentFormIds = [];
      if (form?.parentFormId) {
        try {
          const parentConditions = [{ id: form.parentFormId }];
          if (mongoose.Types.ObjectId.isValid(form.parentFormId)) parentConditions.push({ _id: form.parentFormId });
          parentFormDoc = await Form.findOne({ $or: parentConditions }).lean();
          parentFormIds = [form.parentFormId.toString()].concat(
            parentFormDoc ? [parentFormDoc.id, parentFormDoc._id?.toString()].filter(Boolean) : []
          );
        } catch (pfErr) {
          console.warn('[CREATE RANGE] Error loading parent form:', pfErr);
        }
      }

      for (let i = 0; i < chassisRangeList.length; i++) {
        const currentChassis = chassisRangeList[i];
        const clonedAnswers = { ...(answers || {}) };
        const finalChassisNumber =
          configuredFormChassis.length > 0 && configuredFormChassis.includes(chassisVal)
            ? chassisVal
            : currentChassis;

        if (rangeQuestionKey) clonedAnswers[rangeQuestionKey] = currentChassis;

        for (const q of allQuestions) {
          if (
            q.id === rangeQuestionKey ||
            q.type === 'range' ||
            q.type === 'chassisNumber' ||
            q.trackResponseRank ||
            (q.text &&
              (q.text.toLowerCase().includes('chassis') ||
                q.text.toLowerCase().includes('identification') ||
                q.text.toLowerCase().includes('id number')))
          ) {
            if (clonedAnswers[q.id] !== undefined || q.id === rangeQuestionKey) {
              clonedAnswers[q.id] = currentChassis;
            }
            if (q.text && clonedAnswers[q.text] !== undefined) {
              clonedAnswers[q.text] = currentChassis;
            }
          }
        }

        if (clonedAnswers['ID number'] !== undefined) clonedAnswers['ID number'] = currentChassis;
        if (clonedAnswers.id_number !== undefined) clonedAnswers.id_number = currentChassis;
        if (clonedAnswers.idNumber !== undefined) clonedAnswers.idNumber = currentChassis;
        if (clonedAnswers['Identification Number'] !== undefined) clonedAnswers['Identification Number'] = currentChassis;
        if (clonedAnswers.identification_number !== undefined) clonedAnswers.identification_number = currentChassis;
        if (clonedAnswers.identificationNumber !== undefined) clonedAnswers.identificationNumber = currentChassis;
        clonedAnswers.chassis_number = finalChassisNumber;

        const offsetSeconds = chassisRangeList.length - i;
        const itemCreatedAt = new Date(baseNow + offsetSeconds * 1000);

        let itemParentResponseId = resolvedParentResponseId;
        if (!itemParentResponseId && form?.parentFormId && currentChassis) {
          try {
            const orConditions = [
              { chassisNumber: currentChassis },
              { 'answers.chassis_number': currentChassis },
              { 'answers.chassisNumber': currentChassis },
              { 'answers.id_number': currentChassis },
              { 'answers.idNumber': currentChassis },
              { 'answers.Identification Number': currentChassis },
              { 'answers.identification_number': currentChassis },
              { 'answers.identificationNumber': currentChassis },
              { 'answers.ID number': currentChassis },
              { 'answers.Chassis / VIN': currentChassis },
              { 'answers.Chassis No': currentChassis },
              { 'answers.CHASSIS NUMBER': currentChassis },
            ];
            if (parentFormDoc) {
              (parentFormDoc.sections || []).forEach((s) =>
                (s.questions || []).forEach((q) => {
                  orConditions.push({ [`answers.${q.id}`]: currentChassis });
                  if (q.text) orConditions.push({ [`answers.${q.text}`]: currentChassis });
                })
              );
              (parentFormDoc.followUpQuestions || []).forEach((q) => {
                orConditions.push({ [`answers.${q.id}`]: currentChassis });
                if (q.text) orConditions.push({ [`answers.${q.text}`]: currentChassis });
              });
            }
            const pUnit = await Response.findOne({
              questionId: { $in: parentFormIds },
              isSectionSubmit: { $ne: true },
              $or: orConditions,
            })
              .sort({ createdAt: -1 })
              .lean();
            if (pUnit) {
              itemParentResponseId = pUnit.id || (pUnit._id ? pUnit._id.toString() : null);
            }
          } catch (pErr) {
            console.warn('[CREATE RESPONSE] Error auto-linking parent for range item:', pErr);
          }
        }

        const singleRespData = {
          ...responseData,
          id: uuidv4(),
          batchId: rangeBatchId,
          parentResponseId: itemParentResponseId || undefined,
          chassisNumber: finalChassisNumber,
          createdAt: itemCreatedAt,
          timestamp: itemCreatedAt.toISOString(),
          submittedAt: itemCreatedAt,
          answers: new Map(Object.entries(clonedAnswers)),
        };

        const respDoc = new Response(singleRespData);
        await respDoc.save({ timestamps: false });
        createdResponses.push(respDoc);

        const singleAnswersObj =
          respDoc.answers instanceof Map ? Object.fromEntries(respDoc.answers) : respDoc.answers;
        const ranksObj =
          respDoc.responseRanks instanceof Map
            ? Object.fromEntries(respDoc.responseRanks)
            : respDoc.responseRanks;
        const singlePayload = {
          id: respDoc.id,
          questionId: respDoc.questionId,
          status: respDoc.status,
          submittedBy: respDoc.submittedBy,
          createdAt: respDoc.createdAt,
          answers: singleAnswersObj,
          inviteId: inviteId || null,
          timeSpent: submissionTimeSpent,
          responseRanks: ranksObj,
        };
        emitResponseCreated(questionId, singlePayload);
        if (form?._id && String(form._id) !== String(questionId)) emitResponseCreated(String(form._id), singlePayload);
        if (form?.id && String(form.id) !== String(questionId)) emitResponseCreated(String(form.id), singlePayload);
      }
      primaryResponse = createdResponses[0];
    } else {
      const response = new Response(responseData);
      await response.save();
      primaryResponse = response;
      createdResponses = [response];

      const answersObj = response.answers instanceof Map ? Object.fromEntries(response.answers) : response.answers;
      const ranksObj =
        response.responseRanks instanceof Map ? Object.fromEntries(response.responseRanks) : response.responseRanks;

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
      if (form?._id && String(form._id) !== String(questionId)) emitResponseCreated(String(form._id), livePayload);
      if (form?.id && String(form.id) !== String(questionId)) emitResponseCreated(String(form.id), livePayload);
    }

    // ── Invalidate caches on write ──
    clearRankCache(questionId);
    clearRankCache(form?.id);
    try {
      if (typeof invalidateCache === 'function') invalidateCache(questionId);
    } catch (e) {
      /* cache util may not accept this key — safe to ignore */
    }

    const finalResponse = primaryResponse;
    const answersObj = finalResponse.answers instanceof Map ? Object.fromEntries(finalResponse.answers) : finalResponse.answers;
    const ranksObj =
      finalResponse.responseRanks instanceof Map
        ? Object.fromEntries(finalResponse.responseRanks)
        : finalResponse.responseRanks;

    // ── Background drive backup ──
    const driveConfigured = !!(
      process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN
    );
    if (driveConfigured) {
      setImmediate(async () => {
        try {
          const metadata = {
            tenantId: form.tenantId,
            formId: questionId,
            submissionId: `resp-${Date.now()}`,
            submissionTimestamp: Date.now(),
            driveEnabled: true,
          };
          const processingResult = await processResponseImages(answers, metadata, null, `response-${Date.now()}`);
          if (processingResult && processingResult.processedAnswers) {
            await Response.updateOne(
              { id: finalResponse.id },
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
                    status: processingResult.error ? 'partial' : 'completed',
                  },
                },
              }
            );
          }
        } catch (bgError) {
          console.error('[BACKGROUND IMAGE PROCESS ERROR]', bgError);
        }
      });
    }

    res.status(201).json({
      success: true,
      message:
        createdResponses.length > 1
          ? `Successfully created ${createdResponses.length} responses for chassis range ${chassisRangeList[0]} to ${chassisRangeList[chassisRangeList.length - 1]}`
          : 'Response submitted successfully',
      data: {
        response: {
          id: finalResponse.id,
          questionId: finalResponse.questionId,
          answers: answersObj,
          responseRanks: ranksObj,
          parentResponseId: finalResponse.parentResponseId,
          chassisNumber: finalResponse.chassisNumber,
          submittedBy: finalResponse.submittedBy,
          submitterContact: finalResponse.submitterContact,
          status: finalResponse.status,
          createdAt: finalResponse.createdAt,
          updatedAt: finalResponse.updatedAt,
          inviteId: inviteId || null,
          imageProcessing: { totalImages: 0, driveBackups: 0, folderPath: null },
          timeSpent: submissionTimeSpent,
          timeSpentFormatted: formatTimeDuration(submissionTimeSpent),
          startedAt: actualStartedAt,
          completedAt: actualCompletedAt,
          questionTimings: formSession?.questionTimings,
          sectionTimings: formSession?.sectionTimings,
        },
        count: createdResponses.length,
        batchId: rangeBatchId || undefined,
        responses: createdResponses.map((r) => ({ id: r.id, chassisNumber: r.chassisNumber })),
        score: {
          correct,
          total,
          percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
        },
        imageProcessing: { status: 'completed', stats: {} },
        inviteStatus,
        timing: {
          timeSpent: submissionTimeSpent,
          timeSpentFormatted: formatTimeDuration(submissionTimeSpent),
          startedAt: actualStartedAt,
          completedAt: actualCompletedAt,
          hasSession: !!formSession,
          sessionId: sessionId || formSession?.sessionId,
        },
      },
    });
  } catch (error) {
    console.error('Create response error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error: error.message || String(error),
    });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// batchImportResponses
// ═════════════════════════════════════════════════════════════════════════════
export const batchImportResponses = async (req, res) => {
  let batchId;
  try {
    console.log('=== BATCH IMPORT ===');
    const { questionId, questionID, responses } = req.body;
    const actualQuestionId = questionId || questionID;
    batchId = req.body.batchId || `batch-${Date.now()}`;

    if (!actualQuestionId || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }

    const searchConditions = [{ id: actualQuestionId }];
    if (mongoose.Types.ObjectId.isValid(actualQuestionId)) {
      searchConditions.push({ _id: new mongoose.Types.ObjectId(String(actualQuestionId)) }, { _id: actualQuestionId });
    }
    const form = await Form.findOne({ $or: searchConditions });
    if (!form) {
      return res.status(404).json({ success: false, message: `Form with ID "${actualQuestionId}" not found` });
    }

    const submissionMetadata = await collectSubmissionMetadata(req, {
      includeLocation: form.locationEnabled !== false,
    });

    const extractChassisFromAns = (ans) => {
      if (!ans) return null;
      const plain = ans instanceof Map ? Object.fromEntries(ans) : ans;
      let val = extractAnswerString(
        plain.chassis_number ||
        plain.selected_chassis ||
        plain.selectedChassis ||
        plain.chassisNumber ||
        plain.id_number ||
        plain.idNumber ||
        plain['ID number'] ||
        plain['Identification Number'] ||
        plain.identification_number ||
        plain.identificationNumber ||
        plain['Chassis / VIN'] ||
        plain['Chassis No'] ||
        plain['CHASSIS NUMBER']
      );
      if (!val && form) {
        const allFormQuestions = [];
        (form.sections || []).forEach((s) => (s.questions || []).forEach((q) => allFormQuestions.push(q)));
        (form.followUpQuestions || []).forEach((q) => allFormQuestions.push(q));
        for (const q of allFormQuestions) {
          if (
            q.trackResponseRank ||
            q.type === 'range' ||
            q.type === 'chassisNumber' ||
            (q.text && (q.text.toLowerCase().includes('chassis') || q.text.toLowerCase().includes('identification')))
          ) {
            const raw = plain[q.id] || plain[q.text] || plain[`${q.id}_tracking`];
            const str = extractAnswerString(raw);
            if (str && str !== '-' && str !== 'N/A') {
              val = str;
              break;
            }
          }
        }
      }
      return val ? String(val).trim() : null;
    };

    const isFollowUpBatch =
      Boolean(form.parentFormId) || String(batchId).includes('-t2') || String(batchId).includes('-fu-');
    const chassisToParentMap = new Map();

    if (isFollowUpBatch) {
      const chassisListInBatch = responses
        .map((r) => extractChassisFromAns(r.answers) || (r.chassisNumber ? String(r.chassisNumber).trim() : null))
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
            { 'answers.Identification Number': { $in: uniqueChassisInBatch } },
            { 'answers.identification_number': { $in: uniqueChassisInBatch } },
            { 'answers.identificationNumber': { $in: uniqueChassisInBatch } },
            { 'answers.ID number': { $in: uniqueChassisInBatch } },
            { 'answers.Chassis / VIN': { $in: uniqueChassisInBatch } },
            { 'answers.Chassis No': { $in: uniqueChassisInBatch } },
            { 'answers.CHASSIS NUMBER': { $in: uniqueChassisInBatch } },
          ],
        };
        if (!form.parentFormId) parentQuery.batchId = { $ne: batchId };

        try {
          const matchedParents = await Response.find(parentQuery)
            .select('id _id chassisNumber answers createdAt status submittedBy')
            .sort({ createdAt: -1 })
            .lean();
          matchedParents.forEach((p) => {
            const pAns = p.answers instanceof Map ? Object.fromEntries(p.answers) : p.answers || {};
            const pChassis = (p.chassisNumber || extractChassisFromAns(pAns) || '').toLowerCase().trim();
            if (pChassis && !chassisToParentMap.has(pChassis)) {
              chassisToParentMap.set(pChassis, p.id || (p._id ? p._id.toString() : null));
            }
          });
        } catch (matchErr) {
          console.warn('[BATCH IMPORT] Error prefetching parent responses:', matchErr);
        }
      }
    }

    const collectAllQuestions = (questions, result = []) => {
      if (!Array.isArray(questions)) return result;
      questions.forEach((q) => {
        result.push(q);
        if (Array.isArray(q.followUpQuestions)) collectAllQuestions(q.followUpQuestions, result);
      });
      return result;
    };
    const allQuestions = [];
    (form.sections || []).forEach((s) => collectAllQuestions(s.questions, allQuestions));
    collectAllQuestions(form.followUpQuestions, allQuestions);

    const rankTrackedQuestions = allQuestions.filter((q) => q.trackResponseRank || q.trackResponseQuestion);
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
              { [`answers.${trackingQId}`]: { $exists: true, $ne: null } },
            ],
          },
        },
        { $project: { answerVal: { $ifNull: [`$answers.${qId}`, `$answers.${trackingQId}`] } } },
        { $group: { _id: '$answerVal', count: { $sum: 1 } } },
      ]);
      const map = new Map();
      counts.forEach((c) => {
        const strVal = extractAnswerString(c._id);
        if (strVal !== '') map.set(strVal.toLowerCase(), c.count);
      });
      rankMaps[qId] = map;
    }

    const allGoogleDriveUrls = [];
    const urlToResponseMap = new Map();
    responses.forEach((response, responseIndex) => {
      const { answers } = response;
      if (!answers || typeof answers !== 'object') return;
      Object.entries(answers).forEach(([answerKey, answer]) => {
        if (!answer) return;
        if (typeof answer === 'string' && isGoogleDriveUrl(answer)) {
          allGoogleDriveUrls.push({ url: answer, questionId: answerKey, responseIndex, type: 'single' });
          urlToResponseMap.set(`${responseIndex}_${answerKey}`, answer);
        } else if (Array.isArray(answer)) {
          answer.forEach((item, itemIndex) => {
            if (typeof item === 'string' && isGoogleDriveUrl(item)) {
              allGoogleDriveUrls.push({
                url: item, questionId: answerKey, responseIndex, arrayIndex: itemIndex, type: 'array',
              });
              urlToResponseMap.set(`${responseIndex}_${answerKey}_${itemIndex}`, item);
            }
          });
        }
      });
    });

    const createdResponses = [];
    const errors = [];

    if (allGoogleDriveUrls.length > 0) {
      try {
        emitImageProgress(batchId, {
          processed: 0, total: allGoogleDriveUrls.length,
          status: 'processing', message: `Starting batch processing of ${allGoogleDriveUrls.length} images...`,
        });

        const batchAnswers = {};
        const urlMapping = {};
        allGoogleDriveUrls.forEach((item, index) => {
          const uniqueKey = `batch_${index}`;
          batchAnswers[uniqueKey] = item.url;
          urlMapping[uniqueKey] = item;
        });

        const onProgressCallback = (progress) => {
          emitImageProgress(batchId, {
            processed: progress.currentImage, total: progress.totalImages,
            status: progress.status,
            message: progress.message || 'Processing images...',
            percentage: progress.percentage,
          });
        };

        const metadata = {
          tenantId: form.tenantId, formId: actualQuestionId,
          submissionId: `batch-${batchId}`, submissionTimestamp: Date.now(),
        };

        const processedBatch = await processResponseImages(batchAnswers, metadata, onProgressCallback, batchId);

        const processedUrlMap = new Map();
        const driveBackupMap = new Map();
        Object.entries(processedBatch.processedAnswers).forEach(([uniqueKey, cloudinaryUrl]) => {
          const item = urlMapping[uniqueKey];
          if (item && cloudinaryUrl !== item.url) {
            processedUrlMap.set(item.url, cloudinaryUrl);
            if (processedBatch.driveBackupUrls && processedBatch.driveBackupUrls[uniqueKey]) {
              driveBackupMap.set(item.url, processedBatch.driveBackupUrls[uniqueKey]);
            }
          }
        });

        const responsesToSave = [];
        for (let index = 0; index < responses.length; index++) {
          try {
            const { answers, submittedBy, submitterContact, parentResponseId } = responses[index];
            const processedAnswers = {};
            Object.entries(answers || {}).forEach(([answerKey, answer]) => {
              if (!answer) {
                processedAnswers[answerKey] = answer;
                return;
              }
              if (typeof answer === 'string' && isGoogleDriveUrl(answer)) {
                processedAnswers[answerKey] = processedUrlMap.get(answer) || answer;
              } else if (Array.isArray(answer)) {
                processedAnswers[answerKey] = answer.map((item) =>
                  typeof item === 'string' && isGoogleDriveUrl(item) ? processedUrlMap.get(item) || item : item
                );
              } else {
                processedAnswers[answerKey] = answer;
              }
            });

            let correct = 0;
            let total = 0;
            allQuestions.forEach((question) => {
              if (question.type === 'yesNoNA') {
                total++;
                const answer = processedAnswers[question.id];
                if (answer && String(answer).toLowerCase() === 'yes') correct++;
              }
            });

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

            let chassisVal =
              extractChassisFromAns(processedAnswers) ||
              (responses[index]?.chassisNumber ? String(responses[index].chassisNumber).trim() : undefined);
            const batchConfiguredChassis = (form.chassisNumbers || [])
              .map((c) => (typeof c === 'string' ? c : c.chassisNumber || c.name))
              .filter(Boolean);
            if (batchConfiguredChassis.length > 0) {
              if (chassisVal && !batchConfiguredChassis.includes(chassisVal)) {
                const matchingAns = Object.values(processedAnswers).find(
                  (v) => typeof v === 'string' && batchConfiguredChassis.includes(v.trim())
                );
                if (matchingAns) chassisVal = typeof matchingAns === 'string' ? matchingAns.trim() : matchingAns;
                else if (batchConfiguredChassis.length === 1) chassisVal = batchConfiguredChassis[0];
              } else if (!chassisVal && batchConfiguredChassis.length === 1) {
                chassisVal = batchConfiguredChassis[0];
              }
            } else if (!chassisVal) {
              for (const q of allQuestions) {
                if (
                  q.trackResponseRank ||
                  q.type === 'chassisNumber' ||
                  (q.text && q.text.toLowerCase().includes('chassis') && !q.text.toLowerCase().includes('zone'))
                ) {
                  const qVal = extractAnswerString(processedAnswers[q.id] || processedAnswers[`${q.id}_tracking`]);
                  if (qVal) {
                    chassisVal = qVal;
                    break;
                  }
                }
              }
            }
            if (chassisVal && !processedAnswers.chassis_number) processedAnswers.chassis_number = chassisVal;

            let resolvedParentResponseId = parentResponseId;
            if (!resolvedParentResponseId && chassisVal) {
              resolvedParentResponseId = chassisToParentMap.get(chassisVal.toLowerCase().trim()) || undefined;
            }

            const rawDateVal =
              responses[index]?.submittedAt ||
              responses[index]?.createdAt ||
              responses[index]?.timestamp ||
              processedAnswers['submittedAt'] ||
              processedAnswers['Submitted Date *'] ||
              processedAnswers['Submitted Date'] ||
              processedAnswers['submitted date'] ||
              processedAnswers['submittedDate'] ||
              processedAnswers['Timestamp'] ||
              processedAnswers['timestamp'] ||
              processedAnswers['Date'] ||
              processedAnswers['date'] ||
              processedAnswers['Inspection Date'] ||
              processedAnswers['Created At'] ||
              processedAnswers['createdAt'];
            const rowSubmittedAt = parseExcelDateBackend(rawDateVal) || new Date();

            const isDispVal = String(
              responses[index]?.isDispatched || processedAnswers['Dispatched'] || processedAnswers['dispatched'] || ''
            )
              .toLowerCase()
              .trim();
            const isDispatched = isDispVal === 'yes' || isDispVal === 'true' || responses[index]?.isDispatched === true;
            const rawDispAt =
              responses[index]?.dispatchedAt ||
              processedAnswers['Dispatched At'] ||
              processedAnswers['dispatchedAt'] ||
              processedAnswers['dispatched at'];
            const rowDispatchedAt = isDispatched ? parseExcelDateBackend(rawDispAt) || rowSubmittedAt : undefined;

            const rawStatusVal =
              responses[index]?.status || processedAnswers['Status'] || processedAnswers['status'];
            const rowStatus = rawStatusVal ? String(rawStatusVal).trim() : 'pending';

            const formQuestionIds = new Set(
              allQuestions.map((q) => q.id || (q._id ? q._id.toString() : null)).filter(Boolean)
            );
            [
              'Timestamp', 'timestamp', 'Date', 'date', 'Status', 'status', 'Dispatched', 'dispatched',
              'Dispatched At', 'dispatched at', 'submittedAt', 'isDispatched', 'dispatchedAt',
              'Submitted Date', 'Submitted Date *', 'submitted date', 'submittedDate',
            ].forEach((k) => {
              if (!formQuestionIds.has(k)) delete processedAnswers[k];
            });

            const rowSubmissionMetadata = {
              ...(submissionMetadata || {}),
              submittedAt: rowSubmittedAt,
              capturedLocation: submissionMetadata?.capturedLocation
                ? { ...submissionMetadata.capturedLocation, capturedAt: rowSubmittedAt }
                : undefined,
            };

            const responseData = {
              id: uuidv4(),
              questionId: actualQuestionId,
              answers: new Map(Object.entries(processedAnswers)),
              responseRanks: new Map(Object.entries(responseRanks)),
              parentResponseId: resolvedParentResponseId || undefined,
              batchId,
              chassisNumber: chassisVal || undefined,
              submittedBy: submittedBy || 'Excel Import',
              submitterContact,
              submissionMetadata: rowSubmissionMetadata,
              status: rowStatus,
              isDispatched,
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
              createdAt: rowSubmittedAt,
            };

            const rowRange =
              extractRangeBounds(chassisVal) ||
              extractRangeBounds(processedAnswers['Identification Number']) ||
              extractRangeBounds(processedAnswers['ID number']) ||
              extractRangeBounds(processedAnswers.chassis_number);
            let rowUnits = [];
            if (rowRange && rowRange.start && rowRange.end) {
              rowUnits = expandChassisRange(rowRange.start, rowRange.end);
            }

            if (rowUnits.length > 1) {
              const baseTime = rowSubmittedAt.getTime();
              for (let uIdx = 0; uIdx < rowUnits.length; uIdx++) {
                const uChassis = rowUnits[uIdx];
                const uAnswers = { ...processedAnswers };
                const uFinalChassis =
                  batchConfiguredChassis.length > 0 && batchConfiguredChassis.includes(chassisVal)
                    ? chassisVal
                    : uChassis;
                uAnswers.chassis_number = uFinalChassis;
                if (uAnswers['Identification Number'] !== undefined) uAnswers['Identification Number'] = uChassis;
                if (uAnswers['identification_number'] !== undefined) uAnswers['identification_number'] = uChassis;
                if (uAnswers.identificationNumber !== undefined) uAnswers.identificationNumber = uChassis;
                if (uAnswers['ID number'] !== undefined) uAnswers['ID number'] = uChassis;
                if (uAnswers.id_number !== undefined) uAnswers.id_number = uChassis;
                for (const q of allQuestions) {
                  if (
                    q.trackResponseRank ||
                    q.type === 'range' ||
                    (q.text &&
                      (q.text.toLowerCase().includes('chassis') || q.text.toLowerCase().includes('identification')))
                  ) {
                    if (uAnswers[q.id] !== undefined) uAnswers[q.id] = uChassis;
                  }
                }
                let uParentId = resolvedParentResponseId;
                if (!uParentId && uChassis) {
                  uParentId = chassisToParentMap.get(uChassis.toLowerCase().trim()) || undefined;
                }
                const uDate = new Date(baseTime + (rowUnits.length - uIdx) * 1000);
                responsesToSave.push(
                  new Response({
                    ...responseData,
                    id: uuidv4(),
                    answers: new Map(Object.entries(uAnswers)),
                    parentResponseId: uParentId || undefined,
                    chassisNumber: uFinalChassis,
                    submittedAt: uDate,
                    createdAt: uDate,
                  })
                );
              }
            } else {
              responsesToSave.push(new Response(responseData));
            }
          } catch (error) {
            console.error(`[BATCH ${batchId}] Response prep error (index ${index}):`, error.message);
            errors.push({ index, submittedBy: responses[index]?.submittedBy || 'Unknown', error: error.message });
          }
        }

        const batchSize = 250;
        for (let i = 0; i < responsesToSave.length; i += batchSize) {
          const chunk = responsesToSave.slice(i, i + batchSize);
          try {
            const inserted = await Response.insertMany(chunk, { ordered: false });
            inserted.forEach((doc) =>
              createdResponses.push({
                id: doc.id, submittedBy: doc.submittedBy, chassisNumber: doc.chassisNumber,
                parentResponseId: doc.parentResponseId, status: 'success',
              })
            );
          } catch (error) {
            if (error.insertedDocs && error.insertedDocs.length > 0) {
              error.insertedDocs.forEach((doc) =>
                createdResponses.push({
                  id: doc.id, submittedBy: doc.submittedBy, chassisNumber: doc.chassisNumber,
                  parentResponseId: doc.parentResponseId, status: 'success',
                })
              );
            }
            if (error.writeErrors && error.writeErrors.length > 0) {
              error.writeErrors.forEach((we) =>
                errors.push({ submittedBy: 'Import row', error: we.errmsg || we.message })
              );
            } else {
              await Promise.all(
                chunk.map(async (response) => {
                  try {
                    if (response.submittedAt) await response.save({ timestamps: false });
                    else await response.save();
                    createdResponses.push({
                      id: response.id, submittedBy: response.submittedBy,
                      chassisNumber: response.chassisNumber,
                      parentResponseId: response.parentResponseId, status: 'success',
                    });
                  } catch (singleErr) {
                    errors.push({ submittedBy: response.submittedBy, error: singleErr.message });
                  }
                })
              );
            }
          }
        }

        if (typeof emitBatchImported === 'function') {
          const batchInfo = { batchId, count: createdResponses.length, total: responses.length, formId: actualQuestionId };
          emitBatchImported(actualQuestionId, batchInfo);
          if (form?.id && String(form.id) !== String(actualQuestionId)) emitBatchImported(form.id, batchInfo);
          if (form?._id && String(form._id) !== String(actualQuestionId)) emitBatchImported(String(form._id), batchInfo);
        }

        emitImageProgress(batchId, {
          processed: allGoogleDriveUrls.length, total: allGoogleDriveUrls.length,
          status: 'complete',
          message: `✓ Batch processing complete: ${createdResponses.length}/${responses.length} responses saved`,
        });
      } catch (error) {
        console.error(`[BATCH ${batchId}] Batch processing error:`, error);
        errors.push({ index: 'batch', submittedBy: 'batch', error: error.message });
      }

      const extractedChassis = [];
      for (const resp of responses) {
        if (resp?.answers) {
          for (const [k, v] of Object.entries(resp.answers)) {
            if (
              typeof v === 'string' && v.trim() &&
              (k.toLowerCase().includes('chassis') ||
                k.toLowerCase().includes('vin') ||
                k.toLowerCase().includes('id number') ||
                k === 'chassis_number')
            ) {
              if (!extractedChassis.includes(v.trim())) extractedChassis.push(v.trim());
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
        dataCount: { total: responses.length, success: createdResponses.length, failed: errors.length },
        details: {
          chassisNumbers: extractedChassis,
          submitters: Array.from(new Set(responses.map((r) => r.submittedBy).filter(Boolean))),
          questionsCount: Object.keys(responses[0]?.answers || {}).length,
          errors: errors.slice(0, 10),
          notes: `Imported ${createdResponses.length} of ${responses.length} responses (with images)`,
        },
        status: errors.length === 0 ? 'success' : createdResponses.length > 0 ? 'partial' : 'failed',
      }).catch((err) => console.error('[IMPORT HISTORY LOG ERROR]', err));

      clearRankCache(actualQuestionId);
      clearRankCache(form?.id);

      return res.status(201).json({
        success: true,
        message: `Batch import completed: ${createdResponses.length} responses imported successfully`,
        data: {
          imported: createdResponses.length,
          total: responses.length,
          failed: errors.length,
          createdResponses,
          imageConversion: {
            total: allGoogleDriveUrls.length, converted: allGoogleDriveUrls.length,
            status: allGoogleDriveUrls.length > 0 ? 'completed' : 'not_required', batchId,
          },
          errors: errors.length > 0 ? errors : undefined,
        },
      });
    } else {
      // No images
      const responsesToSave = [];
      for (let index = 0; index < responses.length; index++) {
        try {
          const { answers, submittedBy, submitterContact, parentResponseId } = responses[index];
          const processedAnswers = {};
          if (answers && typeof answers === 'object') {
            Object.entries(answers).forEach(([k, v]) => {
              processedAnswers[k] = v;
            });
          }

          let correct = 0;
          let total = 0;
          allQuestions.forEach((question) => {
            if (question.type === 'yesNoNA') {
              total++;
              const answer = processedAnswers[question.id];
              if (answer && String(answer).toLowerCase() === 'yes') correct++;
            }
          });

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

          const chassisVal =
            extractChassisFromAns(processedAnswers) ||
            (responses[index]?.chassisNumber ? String(responses[index].chassisNumber).trim() : undefined);
          let resolvedParentResponseId = parentResponseId;
          if (!resolvedParentResponseId && chassisVal) {
            resolvedParentResponseId = chassisToParentMap.get(chassisVal.toLowerCase().trim()) || undefined;
          }

          const rawDateVal =
            responses[index]?.submittedAt ||
            responses[index]?.createdAt ||
            responses[index]?.timestamp ||
            processedAnswers['submittedAt'] ||
            processedAnswers['Submitted Date *'] ||
            processedAnswers['Submitted Date'] ||
            processedAnswers['submitted date'] ||
            processedAnswers['submittedDate'] ||
            processedAnswers['Timestamp'] ||
            processedAnswers['timestamp'] ||
            processedAnswers['Date'] ||
            processedAnswers['date'] ||
            processedAnswers['Inspection Date'] ||
            processedAnswers['Created At'] ||
            processedAnswers['createdAt'];
          const rowSubmittedAt = parseExcelDateBackend(rawDateVal) || new Date();

          const isDispVal = String(
            responses[index]?.isDispatched || processedAnswers['Dispatched'] || processedAnswers['dispatched'] || ''
          )
            .toLowerCase()
            .trim();
          const isDispatched = isDispVal === 'yes' || isDispVal === 'true' || responses[index]?.isDispatched === true;
          const rawDispAt =
            responses[index]?.dispatchedAt ||
            processedAnswers['Dispatched At'] ||
            processedAnswers['dispatchedAt'] ||
            processedAnswers['dispatched at'];
          const rowDispatchedAt = isDispatched ? parseExcelDateBackend(rawDispAt) || rowSubmittedAt : undefined;

          const rawStatusVal = responses[index]?.status || processedAnswers['Status'] || processedAnswers['status'];
          const rowStatus = rawStatusVal ? String(rawStatusVal).trim() : 'pending';

          const formQuestionIds = new Set(
            allQuestions.map((q) => q.id || (q._id ? q._id.toString() : null)).filter(Boolean)
          );
          [
            'Timestamp', 'timestamp', 'Date', 'date', 'Status', 'status', 'Dispatched', 'dispatched',
            'Dispatched At', 'dispatched at', 'submittedAt', 'isDispatched', 'dispatchedAt',
            'Submitted Date', 'Submitted Date *', 'submitted date', 'submittedDate',
          ].forEach((k) => {
            if (!formQuestionIds.has(k)) delete processedAnswers[k];
          });

          const rowSubmissionMetadata = {
            ...(submissionMetadata || {}),
            submittedAt: rowSubmittedAt,
            capturedLocation: submissionMetadata?.capturedLocation
              ? { ...submissionMetadata.capturedLocation, capturedAt: rowSubmittedAt }
              : undefined,
          };

          const responseData = {
            id: uuidv4(),
            questionId: actualQuestionId,
            answers: new Map(Object.entries(processedAnswers)),
            responseRanks: new Map(Object.entries(responseRanks)),
            parentResponseId: resolvedParentResponseId || undefined,
            batchId,
            chassisNumber: chassisVal || undefined,
            submittedBy: submittedBy || 'Excel Import',
            submitterContact,
            submissionMetadata: rowSubmissionMetadata,
            status: rowStatus,
            isDispatched,
            dispatchedAt: rowDispatchedAt,
            tenantId: form.tenantId,
            score: { correct, total },
            createdBy:
              req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id) ? req.user._id : null,
            submittedAt: rowSubmittedAt,
            createdAt: rowSubmittedAt,
          };

          const noImgConfiguredChassis = (form.chassisNumbers || [])
            .map((c) => (typeof c === 'string' ? c : c.chassisNumber || c.name))
            .filter(Boolean);

          const rowRange =
            extractRangeBounds(chassisVal) ||
            extractRangeBounds(processedAnswers['Identification Number']) ||
            extractRangeBounds(processedAnswers['ID number']) ||
            extractRangeBounds(processedAnswers.chassis_number);
          let rowUnits = [];
          if (rowRange && rowRange.start && rowRange.end) {
            rowUnits = expandChassisRange(rowRange.start, rowRange.end);
          }

          if (rowUnits.length > 1) {
            const baseTime = rowSubmittedAt.getTime();
            for (let uIdx = 0; uIdx < rowUnits.length; uIdx++) {
              const uChassis = rowUnits[uIdx];
              const uAnswers = { ...processedAnswers };
              const uFinalChassis =
                noImgConfiguredChassis.length > 0 && noImgConfiguredChassis.includes(chassisVal)
                  ? chassisVal
                  : uChassis;
              uAnswers.chassis_number = uFinalChassis;
              if (uAnswers['Identification Number'] !== undefined) uAnswers['Identification Number'] = uChassis;
              if (uAnswers['identification_number'] !== undefined) uAnswers['identification_number'] = uChassis;
              if (uAnswers.identificationNumber !== undefined) uAnswers.identificationNumber = uChassis;
              if (uAnswers['ID number'] !== undefined) uAnswers['ID number'] = uChassis;
              if (uAnswers.id_number !== undefined) uAnswers.id_number = uChassis;
              for (const q of allQuestions) {
                if (
                  q.trackResponseRank ||
                  q.type === 'range' ||
                  (q.text &&
                    (q.text.toLowerCase().includes('chassis') || q.text.toLowerCase().includes('identification')))
                ) {
                  if (uAnswers[q.id] !== undefined) uAnswers[q.id] = uChassis;
                }
              }
              let uParentId = resolvedParentResponseId;
              if (!uParentId && uChassis) {
                uParentId = chassisToParentMap.get(uChassis.toLowerCase().trim()) || undefined;
              }
              const uDate = new Date(baseTime + (rowUnits.length - uIdx) * 1000);
              responsesToSave.push(
                new Response({
                  ...responseData,
                  id: uuidv4(),
                  answers: new Map(Object.entries(uAnswers)),
                  parentResponseId: uParentId || undefined,
                  chassisNumber: uFinalChassis,
                  submittedAt: uDate,
                  createdAt: uDate,
                })
              );
            }
          } else {
            responsesToSave.push(new Response(responseData));
          }
        } catch (error) {
          console.error(`[BATCH ${batchId}] Response prep error (no images, index ${index}):`, error.message);
          errors.push({ index, submittedBy: responses[index]?.submittedBy || 'Unknown', error: error.message });
        }
      }

      const batchSize = 250;
      for (let i = 0; i < responsesToSave.length; i += batchSize) {
        const chunk = responsesToSave.slice(i, i + batchSize);
        try {
          const inserted = await Response.insertMany(chunk, { ordered: false });
          inserted.forEach((doc) =>
            createdResponses.push({
              id: doc.id, submittedBy: doc.submittedBy, chassisNumber: doc.chassisNumber,
              parentResponseId: doc.parentResponseId, status: 'success',
            })
          );
        } catch (error) {
          if (error.insertedDocs && error.insertedDocs.length > 0) {
            error.insertedDocs.forEach((doc) =>
              createdResponses.push({
                id: doc.id, submittedBy: doc.submittedBy, chassisNumber: doc.chassisNumber,
                parentResponseId: doc.parentResponseId, status: 'success',
              })
            );
          }
          if (error.writeErrors && error.writeErrors.length > 0) {
            error.writeErrors.forEach((we) =>
              errors.push({ submittedBy: 'Import row', error: we.errmsg || we.message })
            );
          } else {
            await Promise.all(
              chunk.map(async (response) => {
                try {
                  if (response.submittedAt) await response.save({ timestamps: false });
                  else await response.save();
                  createdResponses.push({
                    id: response.id, submittedBy: response.submittedBy,
                    chassisNumber: response.chassisNumber,
                    parentResponseId: response.parentResponseId, status: 'success',
                  });
                } catch (singleErr) {
                  errors.push({ submittedBy: response.submittedBy, error: singleErr.message });
                }
              })
            );
          }
        }
      }

      if (typeof emitBatchImported === 'function') {
        const batchInfo = { batchId, count: createdResponses.length, total: responses.length, formId: actualQuestionId };
        emitBatchImported(actualQuestionId, batchInfo);
        if (form?.id && String(form.id) !== String(actualQuestionId)) emitBatchImported(form.id, batchInfo);
        if (form?._id && String(form._id) !== String(actualQuestionId)) emitBatchImported(String(form._id), batchInfo);
      }

      const extractedChassis = [];
      for (const resp of responses) {
        if (resp?.answers) {
          for (const [k, v] of Object.entries(resp.answers)) {
            if (
              typeof v === 'string' && v.trim() &&
              (k.toLowerCase().includes('chassis') ||
                k.toLowerCase().includes('vin') ||
                k.toLowerCase().includes('id number') ||
                k === 'chassis_number')
            ) {
              if (!extractedChassis.includes(v.trim())) extractedChassis.push(v.trim());
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
        dataCount: { total: responses.length, success: createdResponses.length, failed: errors.length },
        details: {
          chassisNumbers: extractedChassis,
          submitters: Array.from(new Set(responses.map((r) => r.submittedBy).filter(Boolean))),
          questionsCount: Object.keys(responses[0]?.answers || {}).length,
          errors: errors.slice(0, 10),
          notes: `Imported ${createdResponses.length} of ${responses.length} responses`,
        },
        status: errors.length === 0 ? 'success' : createdResponses.length > 0 ? 'partial' : 'failed',
      }).catch((err) => console.error('[IMPORT HISTORY LOG ERROR]', err));

      clearRankCache(actualQuestionId);
      clearRankCache(form?.id);

      return res.status(201).json({
        success: true,
        message: `Batch import completed: ${createdResponses.length} responses imported successfully`,
        data: {
          imported: createdResponses.length,
          total: responses.length,
          failed: errors.length,
          createdResponses,
          errors: errors.length > 0 ? errors : undefined,
        },
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

// ═════════════════════════════════════════════════════════════════════════════
// checkChassisExists
// ═════════════════════════════════════════════════════════════════════════════
export const checkChassisExists = async (req, res) => {
  try {
    const { formId, chassisNumber } = req.query;
    if (!formId || !chassisNumber) {
      return res.status(400).json({ success: false, message: 'formId and chassisNumber are required' });
    }
    const trimmedChassis = String(chassisNumber).trim();
    if (!trimmedChassis) {
      return res.status(200).json({
        success: true,
        data: { exists: false, count: 0, chassisNumber: '' },
      });
    }

    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) form = await Form.findById(formId);

    const formIds = form ? getThisFormIds(form, formId) : [formId];
    const extraQIds = form ? getThisFormExtraQuestionIds(form) : [];
    const orConditions = buildChassisOrConditions('chassis_number', 'chassis_number_tracking', trimmedChassis, extraQIds);

    const query = {
      $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }],
      $and: [{ $or: orConditions }],
      isSectionSubmit: { $ne: true },
    };

    const count = await Response.countDocuments(query);
    let lastSubmission = null;
    if (count > 0) {
      const latest = await Response.findOne(query)
        .sort({ createdAt: -1 })
        .select('id _id status submittedBy createdAt biwReview chassisNumber')
        .lean();
      if (latest) {
        lastSubmission = {
          id: latest.id || latest._id,
          status: latest.status || 'pending',
          submittedBy: latest.submittedBy || 'Anonymous',
          createdAt: latest.createdAt,
          biwReview: latest.biwReview?.status || null,
        };
      }
    }

    return res.status(200).json({
      success: true,
      data: { exists: count > 0, count, chassisNumber: trimmedChassis, lastSubmission },
    });
  } catch (error) {
    console.error('Check chassis exists error:', error);
    res.status(200).json({
      success: true,
      data: {
        exists: false, count: 0,
        chassisNumber: String(req.query?.chassisNumber || '').trim(),
        lastSubmission: null,
      },
    });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// getFormIdentificationNumbers  (reconstructed)
// ═════════════════════════════════════════════════════════════════════════════
export const getFormIdentificationNumbers = async (req, res) => {
  try {
    const { formId: paramFormId, tenantSlug } = req.params;
    const { formId: queryFormId } = req.query;
    const formId = paramFormId || queryFormId;

    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required' });
    }

    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) form = await Form.findById(formId);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });

    const formIds = getThisFormIds(form, formId);
    const objIds = formIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    const allFormIds = [...formIds, ...objIds];

    const responses = await Response.find({
      $or: [{ questionId: { $in: allFormIds } }, { formId: { $in: allFormIds } }],
      isSectionSubmit: { $ne: true },
    })
      .select('chassisNumber answers createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const allQuestions = [];
    const collectQ = (qs) => {
      (qs || []).forEach((q) => {
        allQuestions.push(q);
        if (Array.isArray(q.followUpQuestions)) collectQ(q.followUpQuestions);
      });
    };
    (form.sections || []).forEach((s) => collectQ(s.questions));
    collectQ(form.followUpQuestions);

    const chassisQuestionIds = allQuestions
      .filter(
        (q) =>
          q.trackResponseRank ||
          q.type === 'chassisNumber' ||
          q.type === 'range' ||
          (q.text &&
            (q.text.toLowerCase().includes('chassis') ||
              q.text.toLowerCase().includes('identification') ||
              q.text.toLowerCase().includes('id number') ||
              q.text.toLowerCase().includes('vin')))
      )
      .map((q) => q.id)
      .filter(Boolean);

    const identifierKeys = new Set([
      'chassis_number', 'chassisNumber', 'selected_chassis', 'selectedChassis',
      'id_number', 'idNumber', 'Identification Number', 'identification_number',
      'identificationNumber', 'ID number', 'ID Number', 'ID NUMBER', 'ID_NUMBER',
      'Chassis / VIN', 'Chassis No', 'CHASSIS NUMBER', 'VIN',
    ]);

    const seen = new Set();
    const identificationNumbers = [];

    for (const resp of responses) {
      const answersObj = resp.answers instanceof Map ? Object.fromEntries(resp.answers) : resp.answers || {};
      const candidates = [];

      if (resp.chassisNumber) candidates.push(resp.chassisNumber);
      for (const key of identifierKeys) {
        if (answersObj[key] !== undefined && answersObj[key] !== null) {
          const val = extractAnswerString(answersObj[key]);
          if (val) candidates.push(val);
        }
      }
      for (const qId of chassisQuestionIds) {
        if (answersObj[qId] !== undefined) {
          const val = extractAnswerString(answersObj[qId]);
          if (val) candidates.push(val);
        }
        const tracking = answersObj[`${qId}_tracking`];
        if (tracking !== undefined) {
          const val = extractAnswerString(tracking);
          if (val) candidates.push(val);
        }
      }

      for (const raw of candidates) {
        const trimmed = String(raw).trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const range = extractRangeBounds(trimmed);
        if (range && range.start && range.end) {
          const expanded = expandChassisRange(range.start, range.end);
          for (const unit of expanded) {
            const uKey = unit.toLowerCase();
            if (!seen.has(uKey)) {
              seen.add(uKey);
              identificationNumbers.push(unit);
            }
          }
        } else {
          identificationNumbers.push(trimmed);
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        formId,
        count: identificationNumbers.length,
        identificationNumbers,
      },
    });
  } catch (error) {
    console.error('getFormIdentificationNumbers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch identification numbers' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// getRank  — upgraded with cache + full attempts payload (replaces getFormAttempts)
// ═════════════════════════════════════════════════════════════════════════════
export const getRank = async (req, res) => {
  try {
    const { formId: queryFormId, questionId, answer } = req.query;
    const { tenantSlug, formId: paramFormId } = req.params;
    const { since, chassisNumber } = req.query;

    const formId = paramFormId || queryFormId;

    if (!formId || !questionId || answer === undefined) {
      return res.status(400).json({
        success: false,
        message: 'formId, questionId, and answer are required',
      });
    }

    const strAnswer = extractAnswerString(answer);
    const answerKey = strAnswer.toLowerCase().trim();
    const cacheKey = `${String(formId)}:${String(questionId)}:${answerKey}`;

    // Serve from cache unless caller explicitly bypasses via `since`
    if (!since) {
      const cached = rankCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return res.status(200).json({ success: true, data: cached.data, cached: true });
      }
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
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

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
      (question.trackResponseQuestion === true || question.trackResponseQuestion === 'true')
    ) {
      trackingQId = `${questionId}_tracking`;
    }

    if (!strAnswer) {
      const emptyData = {
        rank: 1,
        count: 0,
        history: [],
        attempts: [],
        previousStatus: null,
        lastResponseId: null,
        isDispatched: false,
        dispatchedAt: null,
        dispatchedByName: null,
        biwReview: null,
        chatCount: 0,
        lastSubmittedBy: null,
        parentMatch: null,
        followUpStatus: null,
      };
      rankCache.set(cacheKey, { data: emptyData, expiresAt: Date.now() + RANK_CACHE_TTL_MS });
      return res.status(200).json({ success: true, data: emptyData });
    }

    const formIds = getThisFormIds(form, formId);
    const extraQIds = getThisFormExtraQuestionIds(form);
    const orConditions = buildChassisOrConditions(questionId, trackingQId, strAnswer, extraQIds);

    const query = {
      $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }],
      $and: [{ $or: orConditions }],
      isSectionSubmit: { $ne: true },
    };

    const matchingResponses = await Response.find(query)
      .select(
        'id _id status answers responseRanks createdAt submittedAt isSectionSubmit isDispatched dispatchedAt dispatchedByName biwReview submittedBy submittedByName createdBy questionId chassisNumber'
      )
      .sort({ createdAt: 1 })
      .lean();

    if (matchingResponses.length === 0) {
      const isChild = Boolean(form.parentFormId);
      const parentForm = form.parentFormId
        ? await Form.findOne({
          $or: [
            { id: form.parentFormId },
            ...(mongoose.Types.ObjectId.isValid(form.parentFormId) ? [{ _id: form.parentFormId }] : []),
          ],
        })
          .select('id _id title')
          .lean()
        : null;

      const emptyData = {
        rank: 1,
        count: 0,
        history: [],
        attempts: [],
        previousStatus: null,
        lastResponseId: null,
        isDispatched: false,
        dispatchedAt: null,
        dispatchedByName: null,
        biwReview: null,
        chatCount: 0,
        lastSubmittedBy: null,
        parentMatch: isChild
          ? {
            exists: false,
            isParentLinked: false,
            parentFormTitle: parentForm?.title || null,
            parentFormId: parentForm?.id || parentForm?._id?.toString() || null,
            attemptsCount: 0,
            color: 'orange',
            badgeText: 'New Chassis (No Parent Record Found)',
            statusLabel: 'Child Only',
          }
          : null,
        followUpStatus: null,
      };
      rankCache.set(cacheKey, { data: emptyData, expiresAt: Date.now() + RANK_CACHE_TTL_MS });
      return res.status(200).json({ success: true, data: emptyData });
    }

    const sortedResponses = matchingResponses.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    let reworkCount = 0;
    let hasBeenReworked = false;

    const history = sortedResponses.map((resp, index) => {
      const answersMap = resp.answers instanceof Map ? Object.fromEntries(resp.answers) : resp.answers || {};
      const { hasRework, hasReject } = inferSubStatusFromAnswers(answersMap);

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
        biwReview: resp.biwReview || null,
      };
    });

    // Rich attempts list (same shape as old getFormAttempts)
    const attempts = sortedResponses.map((resp, index) => {
      const answersMap = resp.answers instanceof Map ? Object.fromEntries(resp.answers) : resp.answers || {};
      return {
        attemptId: String(resp._id || resp.id || index),
        chassisNumber: resp.chassisNumber || strAnswer || 'UNKNOWN',
        identificationNumber: resp.chassisNumber || strAnswer || 'UNKNOWN',
        rank: index + 1,
        status: history[index].status,
        answers: sanitizeAnswersForClient(answersMap),
        submittedBy: resp.submittedByName || resp.submittedBy || 'Inspector',
        submittedAt: resp.createdAt ? new Date(resp.createdAt).toISOString() : new Date().toISOString(),
      };
    });

    const count = sortedResponses.length;
    const lastResponse = sortedResponses[count - 1];
    const previousStatus = history[count - 1].status;

    const responseIds = sortedResponses.map((r) => String(r.id || r._id));
    let chatCount = 0;
    try {
      if (responseIds.length > 0) {
        chatCount = await ChatMessage.countDocuments({ responseId: { $in: responseIds } });
      }
    } catch (e) {
      console.warn('Chat count query skipped:', e.message);
    }

    const isAnyDispatched = sortedResponses.some((r) => r.isDispatched);
    const lastDispatched = [...sortedResponses].reverse().find((r) => r.isDispatched);
    const lastBiwReviewed = [...sortedResponses].reverse().find((r) => r.biwReview && r.biwReview.status);

    let parentForm = null;
    if (form.parentFormId) {
      parentForm = await Form.findOne({
        $or: [
          { id: form.parentFormId },
          ...(mongoose.Types.ObjectId.isValid(form.parentFormId) ? [{ _id: form.parentFormId }] : []),
        ],
      })
        .select('id _id title childForms')
        .lean();
    }
    if (!parentForm) {
      parentForm = await Form.findOne({
        'childForms.formId': { $in: [form.id, form._id?.toString(), formId] },
      })
        .select('id _id title childForms')
        .lean();
    }

    const isChildForm = Boolean(form.parentFormId || parentForm);
    const isParentForm = Boolean(form.childForms && form.childForms.length > 0);

    let followUpBadge = null;
    {
      const firstRespDate = new Date(sortedResponses[0].createdAt);
      const daysElapsed = Math.max(
        0,
        Math.floor((Date.now() - firstRespDate.getTime()) / (1000 * 60 * 60 * 24))
      );

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
        lastSubmittedBy: lastResponse ? lastResponse.submittedBy || lastResponse.createdBy || null : null,
        lastCreatedAt: lastResponse ? lastResponse.createdAt : null,
        daysElapsed,
        color: badgeColor,
        badgeText,
        statusLabel,
        history,
      };
    }

    // Optional chassis filter (parity with old getFormAttempts behavior)
    let filteredAttempts = attempts;
    if (chassisNumber) {
      const c = String(chassisNumber).trim().toLowerCase();
      filteredAttempts = attempts.filter((a) => {
        const cn = String(a.chassisNumber || '').trim().toLowerCase();
        const idn = String(a.identificationNumber || '').trim().toLowerCase();
        if (cn === c || idn === c) return true;
        for (const val of Object.values(a.answers || {})) {
          if (typeof val === 'string' && val.trim().toLowerCase() === c) return true;
          if (val && typeof val === 'object') {
            const v = String(val.value || val.chassisNumber || '').trim().toLowerCase();
            if (v === c) return true;
          }
        }
        return false;
      });
    }

    const payload = {
      rank: count + 1,
      count,
      history,
      attempts: filteredAttempts,
      previousStatus,
      lastResponseId: lastResponse.id || lastResponse._id,
      isDispatched: isAnyDispatched,
      dispatchedAt: lastDispatched ? lastDispatched.dispatchedAt : null,
      dispatchedByName: lastDispatched ? lastDispatched.dispatchedByName : null,
      biwReview: lastBiwReviewed ? lastBiwReviewed.biwReview : null,
      chatCount,
      lastSubmittedBy: lastResponse ? lastResponse.submittedBy || lastResponse.createdBy || null : null,
      parentMatch: followUpBadge,
      followUpStatus: followUpBadge,
      generatedAt: new Date().toISOString(),
    };

    if (!since) {
      if (rankCache.size > 2000) rankCache.clear();
      rankCache.set(cacheKey, { data: payload, expiresAt: Date.now() + RANK_CACHE_TTL_MS });
    }

    return res.status(200).json({ success: true, data: payload });
  } catch (error) {
    console.error('Get rank error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// getSuggestedAnswers
// ═════════════════════════════════════════════════════════════════════════════
export const getSuggestedAnswers = async (req, res) => {
  try {
    const { formId: queryFormId, questionId, answer } = req.query;
    const { tenantSlug, formId: paramFormId } = req.params;
    const formId = paramFormId || queryFormId;

    if (!formId || !questionId || answer === undefined) {
      return res.status(400).json({ success: false, message: 'formId, questionId, and answer are required' });
    }

    const strAnswer = extractAnswerString(answer);
    if (!strAnswer) return res.status(200).json({ success: true, data: { suggestedAnswers: null } });

    const cacheKey = `${formId}:${questionId}:${strAnswer.toLowerCase().trim()}:${tenantSlug || ''}`;
    const cachedEntry = suggestionsMemoryCache.get(cacheKey);
    if (cachedEntry && Date.now() < cachedEntry.expiresAt) {
      return res.status(200).json({ success: true, data: { suggestedAnswers: cachedEntry.data } });
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

    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });

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
      (question.trackResponseQuestion === true || question.trackResponseQuestion === 'true')
    ) {
      trackingQId = `${questionId}_tracking`;
    }

    const formIds = getThisFormIds(form, formId);
    const extraQIds = getThisFormExtraQuestionIds(form);
    const orConditions = buildChassisOrConditions(questionId, trackingQId, strAnswer, extraQIds);

    const query = {
      $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }],
      $and: [{ $or: orConditions }],
      isSectionSubmit: { $ne: true },
    };

    const matchingResponses = await Response.find(query)
      .select('answers responseRanks createdAt submittedAt status isSectionSubmit questionId _id id')
      .sort({ isSectionSubmit: 1, createdAt: 1 })
      .limit(10)
      .lean();

    if (matchingResponses.length === 0) {
      return res.status(200).json({ success: true, data: { suggestedAnswers: null } });
    }

    const sortedResponses = matchingResponses.sort((a, b) => {
      if (a.isSectionSubmit !== b.isSectionSubmit) return a.isSectionSubmit ? 1 : -1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    let reworkCount = 0;
    let hasBeenReworked = false;

    const suggestions = sortedResponses.map((resp, index) => {
      let answersObj = resp.answers || {};
      if (answersObj instanceof Map) answersObj = Object.fromEntries(answersObj);
      const { hasRework, hasReject } = inferSubStatusFromAnswers(answersObj);

      let status = 'Direct Ok';
      if (hasReject) status = 'Rejected';
      else if (hasRework) {
        reworkCount++;
        hasBeenReworked = true;
        status = `Rework ${reworkCount}`;
      } else if (index > 0 || hasBeenReworked) status = 'Rework Accepted';
      else status = 'Direct Ok';

      return {
        rank: index + 1,
        status: resp.status && resp.status !== 'pending' ? resp.status : status,
        answers: answersObj,
        timestamp: resp.createdAt,
        id: resp.id || resp._id,
        attemptId: (resp._id || resp.id).toString(),
        chassisNumber: strAnswer || resp.chassisNumber || 'UNKNOWN',
        submittedBy: resp.submittedByName || resp.submittedBy || 'Inspector',
        submittedAt: resp.createdAt ? new Date(resp.createdAt).toISOString() : new Date().toISOString(),
      };
    });

    if (suggestionsMemoryCache.size > 2000) suggestionsMemoryCache.clear();
    suggestionsMemoryCache.set(cacheKey, { data: suggestions, expiresAt: Date.now() + 60000 });

    return res.status(200).json({ success: true, data: { suggestedAnswers: suggestions } });
  } catch (error) {
    console.error('[SUGGESTIONS] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch suggested answers' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// batchSyncResponses
// ═════════════════════════════════════════════════════════════════════════════
export const batchSyncResponses = async (req, res) => {
  try {
    const { responses } = req.body;
    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ success: false, message: 'responses array is required' });
    }

    const results = [];
    for (const item of responses) {
      const { idempotencyKey, formId, chassisNumber, answers, clientProvisionalRank, submittedAt, submittedBy } = item;

      let existing = null;
      if (idempotencyKey) {
        existing = await Response.findOne({
          $or: [
            { 'submissionMetadata.idempotencyKey': idempotencyKey },
            { 'submissionMetadata.sessionId': idempotencyKey },
            { sessionId: idempotencyKey },
          ],
        }).lean();
      }

      const chassis = chassisNumber || answers?.chassis_number || answers?.chassisNumber || 'UNKNOWN';

      let form = await Form.findOne({ id: formId });
      if (!form && mongoose.Types.ObjectId.isValid(formId)) form = await Form.findById(formId);
      if (!form) {
        results.push({
          idempotencyKey: idempotencyKey || null,
          serverId: null,
          assignedRank: null,
          success: false,
          error: `Form not found: ${formId}`,
        });
        continue;
      }

      const formIds = getThisFormIds(form, formId);
      const priorCount = await Response.countDocuments({
        $and: [
          { $or: [{ questionId: { $in: formIds } }, { formId: { $in: formIds } }] },
          {
            $or: [
              { chassisNumber: chassis },
              { 'answers.chassis_number': chassis },
              { 'answers.chassisNumber': chassis },
            ],
          },
        ],
      });

      if (existing) {
        results.push({
          idempotencyKey: idempotencyKey || existing._id.toString(),
          serverId: existing._id.toString(),
          assignedRank: existing.rank || (priorCount > 0 ? priorCount : 1),
          success: true,
        });
        continue;
      }

      const assignedRank = priorCount + 1;
      let subStatus = 'Direct Ok';
      if (answers && typeof answers === 'object') {
        const statuses = Object.values(answers)
          .map((v) => (typeof v === 'object' && v ? v.status : v))
          .map((v) => String(v || '').toLowerCase());
        if (statuses.some((s) => s.includes('reject'))) subStatus = 'Rejected';
        else if (statuses.some((s) => s.includes('rework'))) subStatus = 'Rework';
      }

      const newResponse = new Response({
        id: uuidv4(),
        tenantId: form.tenantId,
        questionId: formId,
        formId,
        chassisNumber: chassis,
        rank: assignedRank,
        answers: answers || {},
        submittedBy: submittedBy || req.user?.username || 'Inspector Mobile',
        submittedByName: submittedBy || req.user?.displayName || req.user?.username || 'Inspector',
        status: subStatus === 'Direct Ok' ? 'pending' : subStatus.toLowerCase(),
        subStatus,
        sessionId: idempotencyKey,
        submissionMetadata: {
          source: 'mobile-batch-sync',
          idempotencyKey,
          clientProvisionalRank,
        },
        createdAt: submittedAt ? new Date(submittedAt) : new Date(),
      });

      await newResponse.save();

      results.push({
        idempotencyKey: idempotencyKey || newResponse._id.toString(),
        serverId: newResponse._id.toString(),
        assignedRank,
        success: true,
      });
    }

    clearRankCache();
    return res.status(200).json({ success: true, data: { results } });
  } catch (error) {
    console.error('[BATCH-SYNC] Error processing batch sync:', error);
    return res.status(500).json({ success: false, message: 'Failed to process batch sync' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// getQuestionPreviousAnswers  ($nin fix for null/empty)
// ═════════════════════════════════════════════════════════════════════════════
export const getQuestionPreviousAnswers = async (req, res) => {
  try {
    const { formId: queryFormId, questionId } = req.query;
    const { tenantSlug, formId: paramFormId } = req.params;
    const formId = paramFormId || queryFormId;

    if (!formId || !questionId) {
      return res.status(400).json({ success: false, message: 'formId and questionId are required' });
    }

    let tenantId;
    if (tenantSlug) {
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });
      if (tenant) tenantId = tenant._id;
    }

    let form = await Form.findOne({ id: formId });
    if (!form && mongoose.Types.ObjectId.isValid(formId)) form = await Form.findById(formId);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });

    const trackingQuestionId = `${questionId}_tracking`;
    const query = {
      questionId: { $in: [form.id, form._id.toString()] },
      $or: [
        { [`answers.${questionId}`]: { $exists: true, $nin: [null, ''] } },
        { [`answers.${trackingQuestionId}`]: { $exists: true, $nin: [null, ''] } },
        { [`answers._${questionId}`]: { $exists: true, $nin: [null, ''] } },
        { [`answers._${trackingQuestionId}`]: { $exists: true, $nin: [null, ''] } },
      ],
    };

    if (tenantId) {
      query.tenantId = mongoose.Types.ObjectId.isValid(tenantId)
        ? new mongoose.Types.ObjectId(tenantId)
        : tenantId;
    } else if (form.isGlobal) {
      // global form — no tenant filter
    } else if (form.tenantId) {
      query.tenantId = mongoose.Types.ObjectId.isValid(form.tenantId)
        ? new mongoose.Types.ObjectId(form.tenantId)
        : form.tenantId;
    }

    const uniqueAnswers = await Response.distinct(`answers.${questionId}`, query);
    const uniqueTrackingAnswers = await Response.distinct(`answers.${trackingQuestionId}`, query);

    const allUniqueAnswers = [
      ...new Set([
        ...uniqueAnswers.filter((a) => a !== null && a !== undefined && a !== ''),
        ...uniqueTrackingAnswers.filter((a) => a !== null && a !== undefined && a !== ''),
      ]),
    ];

    return res.status(200).json({
      success: true,
      data: { previousAnswers: allUniqueAnswers, count: allUniqueAnswers.length },
    });
  } catch (error) {
    console.error('[SUGGESTIONS] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch previous answers' });
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
      includePartial = 'false',
      dispatchedOnly = 'false'
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

    // Received a server-side dispatched-only filter? Apply isDispatched: true
    // to the match (existing tenant scoping stays intact).
    if (String(dispatchedOnly).toLowerCase() === 'true') {
      query.isDispatched = true;
    }

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
      const isAdminRole = req.user.role === 'admin' || req.user.role === 'superadmin';

      const isOwnTenant =
        isAdminRole ||
        (response.tenantId && response.tenantId.toString() === req.user.tenantId?.toString());

      // The mobile app is the source of truth for the computed inspection status:
      // its InspectionStatusHelper.computeStatus is group-aware (rework history,
      // group index) and cannot be faithfully reproduced server-side without
      // loading the full response history for the identification number.
      //
      // So we accept the client-declared status as a HINT, verify it is one of
      // the dispatchable ones, and additionally sanity-check against the raw
      // answer map (at least one accepted answer must be present) so a hostile
      // client can't dispatch a response where nothing was accepted.
      const clientComputedStatus =
        typeof req.body.computedStatus === 'string'
          ? req.body.computedStatus.trim()
          : null;

      const DISPATCHABLE = new Set([
        'Direct Ok',
        'Accepted',
        'Rework Accepted',
        'Rework Completed',
      ]);

      // Sanity check from raw answers: at least one value must be a real
      // accepted/verified/rework-completed status (so we can't dispatch an
      // empty or all-rejected response just because the client lied).
      const values =
        typeof response.answers?.values === 'function'
          ? Array.from(response.answers.values())
          : Object.values(response.answers || {});

      const ACCEPTED_VALUES = new Set(['accepted', 'verified', 'rework completed']);
      let anyAccepted = false;
      for (const val of values) {
        const s = typeof val === 'object' && val !== null
          ? String(val.status ?? '').toLowerCase().trim()
          : '';
        if (ACCEPTED_VALUES.has(s)) { anyAccepted = true; break; }
      }

      const isDispatchable =
        clientComputedStatus !== null &&
        DISPATCHABLE.has(clientComputedStatus) &&
        anyAccepted;

      console.log('[DISPATCH]', {
        clientComputedStatus,
        isDispatchable,
        isOwnTenant,
        already: response.isDispatched,
        incoming: req.body.isDispatched,
        anyAccepted,
      });

      if (req.body.isDispatched === true && !response.isDispatched && isOwnTenant && isDispatchable) {
        response.isDispatched = true;
        response.dispatchedAt = new Date();
        response.dispatchedBy = req.user._id;
        response.dispatchedByName =
          `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() ||
          req.user.username || req.user.email || 'Unknown user';
      } else if (req.body.isDispatched === true && !isDispatchable) {
        return res.status(400).json({
          success: false,
          message: `Cannot dispatch — client computed status "${clientComputedStatus ?? 'unknown'}" is not dispatchable`,
        });
      } else if (req.body.isDispatched === false) {
        if (!isAdminRole) {
          return res.status(403).json({ success: false, message: 'Only admins can un-dispatch a response' });
        }
        response.isDispatched = false;
        response.dispatchedAt = null;
        response.dispatchedBy = null;
        response.dispatchedByName = null;
      }
    }
    // ✅ BIW Review — allow inspectors (and subadmins/admins/superadmins)
    // on dispatched responses, including cross-tenant responses where the
    // form is shared with the reviewer's tenant. reviewedBy/reviewedAt are
    // always set server-side from the authenticated user, never trusted
    // from the client.
    if (req.body.hasOwnProperty('biwReview')) {
      const biwReview = req.body.biwReview;

      if (biwReview === null || biwReview === undefined) {
        // Clearing a review is admin/superadmin-only.
        const isAdminRole = req.user.role === 'admin' || req.user.role === 'superadmin';
        if (!isAdminRole) {
          return res.status(403).json({
            success: false,
            message: 'Only admins can clear a BIW review'
          });
        }
        response.biwReview = undefined;
      } else {
        const allowedStatuses = ['Accepted', 'Rejected', 'Reworked'];
        if (!allowedStatuses.includes(biwReview.status)) {
          return res.status(400).json({
            success: false,
            message: `Invalid biwReview status. Must be one of: ${allowedStatuses.join(', ')}`
          });
        }

        // Reviewer must be an inspector/subadmin/admin/superadmin.
        const isInspectorRole = req.user.role === 'inspector' || req.user.role === 'subadmin';
        const isAdminRole = req.user.role === 'admin' || req.user.role === 'superadmin';
        if (!isInspectorRole && !isAdminRole) {
          return res.status(403).json({
            success: false,
            message: 'Only inspectors or admins can submit a BIW review'
          });
        }

        // Dispatched-only rule.
        if (response.isDispatched !== true) {
          return res.status(403).json({
            success: false,
            message: 'BIW review is only available on dispatched responses'
          });
        }

        // Anti-self-review rule.
        const userEmail = req.user.email || '';
        const userUsername = req.user.username || '';
        const userIdStr = req.user._id ? req.user._id.toString() : '';
        const creatorIdStr = originalCreatedBy ? originalCreatedBy.toString() : '';
        const isSubmitter =
          (originalSubmittedBy === userEmail ||
            originalSubmittedBy === userUsername ||
            (originalSubmitterContact && originalSubmitterContact.email === userEmail) ||
            (creatorIdStr && creatorIdStr === userIdStr));
        if (isSubmitter) {
          return res.status(403).json({
            success: false,
            message: 'You cannot BIW review your own submission'
          });
        }

        // Cross-tenant access: resolve the owning form and check whether the
        // reviewer's tenant owns it, shares it, has a chassis-level share, or
        // the form is global.
        let isOwnTenant = false;
        try {
          const formQuery = {
            $or: [
              { id: response.questionId },
              ...(mongoose.Types.ObjectId.isValid(response.questionId)
                ? [{ _id: response.questionId }]
                : []),
            ],
          };
          const form = await Form.findOne(formQuery)
            .select('sharedWithTenants chassisTenantAssignments isGlobal tenantId')
            .lean();

          if (form) {
            const userTenantIdStr = req.user.tenantId ? req.user.tenantId.toString() : null;
            const formTenantIdStr = form.tenantId ? form.tenantId.toString() : null;

            const tenantIdOf = (t) => {
              if (t == null) return null;
              if (typeof t === 'object' && t._id != null) return t._id.toString();
              return t.toString();
            };

            const isSharedTenant =
              Array.isArray(form.sharedWithTenants) &&
              form.sharedWithTenants.some((t) => tenantIdOf(t) === userTenantIdStr);

            const hasChassisShare =
              Array.isArray(form.chassisTenantAssignments) &&
              form.chassisTenantAssignments.some(
                (a) =>
                  Array.isArray(a.assignedTenants) &&
                  a.assignedTenants.some((t) => tenantIdOf(t) === userTenantIdStr),
              );

            isOwnTenant =
              !userTenantIdStr ||
              formTenantIdStr === userTenantIdStr ||
              isSharedTenant ||
              hasChassisShare ||
              form.isGlobal === true;

            console.log('[BIW ACCESS]', {
              userTenantId: userTenantIdStr,
              formTenantId: formTenantIdStr,
              isSharedTenant,
              hasChassisShare,
              isGlobal: form.isGlobal,
              granted: isOwnTenant,
            });
          } else {
            console.warn('[BIW ACCESS] form not found for questionId =', response.questionId);
          }
        } catch (err) {
          console.warn('[updateResponse] Could not resolve form for BIW access check:', err.message);
        }

        if (!isOwnTenant) {
          return res.status(403).json({ success: false, message: 'This form is not shared with your tenant' });
        }

        response.biwReview = {
          status: biwReview.status,
          reviewedBy: req.user._id,
          reviewedByName: req.user.username || req.user.email || 'Reviewer',
          reviewedAt: new Date(),
          remark: biwReview.remark,
          evidenceUrl: biwReview.evidenceUrl,
          flaggedQuestions: biwReview.flaggedQuestions
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
    const { page = 1, limit = 200, status, includePartial = 'false', dispatchedOnly = 'false' } = req.query;

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

    // Received a server-side dispatched-only filter? Apply isDispatched: true
    // to the match. Existing tenant/shared/chassis scoping stays intact.
    if (String(dispatchedOnly).toLowerCase() === 'true') {
      query.isDispatched = true;
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