import express from 'express';
import {
  createForm,
  getAllForms,
  getPublicForms,
  getFormById,
  updateForm,
  deleteForm,
  updateFormVisibility,
  getFormLocationEnabled,
  updateFormLocationEnabled,
  updateFormViewType,
  updateFormActiveStatus,
  duplicateForm,
  getFormAnalytics,
  createFormWithFollowUp,
  updateFollowUpConfig,
  getFollowUpConfig,
  linkChildForm,
  unlinkChildForm,
  getChildForms,
  reorderChildForms,
  setSectionBranching,
  getSectionBranching,
  getSectionBranchingPublic,
  importFormFromCSV,
  getGlobalFormStats,
  submitPublicResponse,
  startFormSession
} from '../controllers/formController.js';
import {
  updateAutoSendConfig,
  getAutoSendConfig,
  getAutoSendHistory
} from '../controllers/autoSendController.js';
import {
  authenticate,
  authenticateOptional,
  adminOnly,
  teacherOrAdmin,
  superAdminOnly,
  authenticateGuest,
} from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';
import { cacheMiddleware } from '../utils/cache.js';
import formInviteRoutes from './formInviteRoutes.js';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

// Middleware for guest access control
const guestAccessControl = (req, res, next) => {
  if (req.user && req.user.isGuest) {
    const { id } = req.params;
    if (id && req.user.accessibleFormId !== id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view data for your assigned form.'
      });
    }
    return next();
  }
  return next();
};

// Public routes (no authentication required)
router.get('/public/:tenantSlug', cacheMiddleware(120), getPublicForms);  // Get all public forms for a tenant
router.get('/:id/public/:tenantSlug', getFormById);  // Get specific form for a tenant
router.get('/:id/section-branching/public/:tenantSlug', getSectionBranchingPublic);

router.post('/:id/public/submit', authenticateOptional, submitPublicResponse);

// Form session tracking (needs to be after public routes but before auth)
router.post('/:id/track/start', startFormSession);

// Track individual question time (non-critical, always 200)
router.post('/:id/track/question', (req, res) => {
  const { sessionId, questionId, questionText, timeSpent } = req.body;
  console.log(`[TIME TRACKING] Question "${questionText || questionId}" - ${timeSpent}s (session: ${sessionId})`);
  return res.status(200).json({ success: true, message: 'Question time tracked' });
});

// Track section completion progress (non-critical, always 200)
router.post('/:id/track/progress', (req, res) => {
  const { sessionId, sectionTitle, timeSpent, questionCount } = req.body;
  console.log(`[TIME TRACKING] Section "${sectionTitle}" completed - ${timeSpent}s, ${questionCount} questions (session: ${sessionId})`);
  return res.status(200).json({ success: true, message: 'Section progress tracked' });
});

// Mark session as complete before form submission (non-critical, always 200)
router.post('/:id/track/complete', (req, res) => {
  const { sessionId } = req.body;
  const formId = req.params.id;
  console.log(`[TIME TRACKING] Session ${sessionId} completed for form ${formId}`);
  return res.status(200).json({ success: true, message: 'Session marked complete' });
});

// Routes requiring guest or standard authentication
router.get('/:id', authenticateGuest, guestAccessControl, cacheMiddleware(60), getFormById);
router.get('/:id/analytics', authenticateGuest, guestAccessControl, cacheMiddleware(60), getFormAnalytics);

// Protected routes (require standard authentication)
router.use(authenticate);
router.use(addTenantFilter);

// Form CRUD operations
router.post('/', createForm);
router.post('/import/csv', upload.single('file'), importFormFromCSV);
router.get('/', getAllForms);
router.get('/public', cacheMiddleware(120), getPublicForms);  // Moved here for tenant isolation
// router.get('/:id', getFormById); // Moved above
router.put('/:id', updateForm);
router.delete('/:id', deleteForm);

// Form management
router.patch('/:id/visibility', updateFormVisibility);
router.get('/:id/location', getFormLocationEnabled);
router.patch('/:id/location', updateFormLocationEnabled);
router.patch('/:id/view-type', updateFormViewType);
router.patch('/:id/active', updateFormActiveStatus);
router.post('/:id/duplicate', duplicateForm);

// Analytics
// router.get('/:id/analytics', getFormAnalytics); // Moved above
router.get('/:id/global-stats', superAdminOnly, getGlobalFormStats);

// Follow-up question management
router.post('/with-followup', createFormWithFollowUp);
router.put('/:id/followup-config', updateFollowUpConfig);
router.get('/:id/followup-config', getFollowUpConfig);

// Child form management (parent-child form relationships)
router.post('/:id/child-forms', linkChildForm);
router.delete('/:id/child-forms/:childFormId', unlinkChildForm);
router.get('/:id/child-forms', getChildForms);
router.put('/:id/child-forms/reorder', reorderChildForms);

// Section branching management
router.post('/:id/section-branching', setSectionBranching);
router.get('/:id/section-branching', getSectionBranching);
router.get('/:id/section-branching/public/:tenantSlug', getSectionBranchingPublic);

// AutoSend routes
router.put('/:id/autosend/config', updateAutoSendConfig);
router.get('/:id/autosend/config', getAutoSendConfig);
router.get('/:id/autosend/history', getAutoSendHistory);

// Form invite routes
router.use('/:formId/invites', formInviteRoutes);

export default router;