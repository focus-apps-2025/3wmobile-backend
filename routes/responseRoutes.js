import express from 'express';
import {
  createResponse,
  batchImportResponses,
  batchSyncResponses,
  getAllResponses,
  getResponseById,
  updateResponse,
  assignResponse,
  deleteResponse,
  deleteMultipleResponses,
  getResponsesByForm,
  exportResponses,
  processBulkImages,
  getRank,
  getUnassignedResponses,
  assignResponses,
  autoAssignResponse,
  getSuggestedAnswers,
  getQuestionPreviousAnswers,
  autoFillChassisNumbers,
  getBiwSummary,
  bulkUpdateBiwReview,
  checkChassisExists,
  getFormIdentificationNumbers,
  bulkImportBiwExcelReviews,
} from '../controllers/responseController.js';
import { getReviewsForResponse, getBulkReviewsForResponses } from '../controllers/userController.js';
import {
  authenticate,
  authenticateOptional,
  adminOnly,
  teacherOrAdmin,
  authenticateGuest,
} from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';
import { cacheMiddleware } from '../utils/cache.js';
import { processResponseImages, processGoogleDriveImage } from '../services/googleDriveService.js';

const router = express.Router();

// ── Reviews (public) ──
router.post('/reviews/bulk', getBulkReviewsForResponses);
router.get('/reviews/:responseId', getReviewsForResponse);

// ── Guest access control ──
const guestAccessControl = (req, res, next) => {
  if (req.user && req.user.isGuest) {
    const formId = req.params.formId || req.query.formId;
    if (formId && req.user.accessibleFormId !== formId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view data for your assigned form.',
      });
    }
  }
  next();
};

console.log('Response router loaded');

// ═════════════════════════════════════════════════════════════════════════
// PUBLIC & GUEST ROUTES
// ═════════════════════════════════════════════════════════════════════════

router.get('/test-route', (req, res) => {
  console.log('Test route hit!');
  res.json({ success: true, message: 'Test route works!' });
});

// Form-specific responses (guests allowed)
router.get('/form/:formId', authenticateGuest, guestAccessControl, cacheMiddleware(30), getResponsesByForm);
router.get('/form/:formId/export', authenticateGuest, guestAccessControl, exportResponses);

// Bulk image processing
router.post('/process-bulk-images', processBulkImages);

// Single image processing
router.post('/process-images', async (req, res) => {
  try {
    const { answers, submissionId } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid request: answers object required' });
    }
    console.log('[PROCESS IMAGES] Converting Google Drive URLs to Cloudinary for preview');
    let processedAnswers = answers;
    try {
      const onProgress = submissionId ? (progressData) => {
        const io = req.app.get('io');
        if (io) {
          io.to(submissionId).emit('image-progress', { submissionId, status: progressData });
          console.log(`[PROGRESS] ${progressData.currentImage}/${progressData.totalImages}`);
        }
      } : null;
      processedAnswers = await processResponseImages(answers, onProgress);
      console.log('[PROCESS IMAGES] Successfully processed all images');
    } catch (error) {
      console.error('[PROCESS IMAGES] Failed to process images:', error.message);
      return res.status(400).json({ success: false, message: 'Failed to process images: ' + error.message });
    }
    res.status(200).json({ success: true, data: processedAnswers });
  } catch (error) {
    console.error('Process images error:', error);
    res.status(500).json({ success: false, message: 'Internal server error during image processing' });
  }
});

// Single image conversion
router.post('/convert-image', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid request: imageUrl (string) required' });
    }
    console.log('[CONVERT IMAGE] Converting single image URL to Cloudinary');
    const cloudinaryUrl = await processGoogleDriveImage(imageUrl, 'display');
    res.status(200).json({ success: true, data: { cloudinaryUrl } });
  } catch (error) {
    console.error('Convert image error:', error);
    res.status(500).json({ success: false, message: 'Internal server error during image conversion' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// BATCH SYNC — MUST BE BEFORE router.use(authenticate) so the
// authenticateOptional middleware can actually run for anonymous offline
// replays. (If you want sync to require a token, move this below the
// auth middleware and drop authenticateOptional.)
// ═════════════════════════════════════════════════════════════════════════
router.post('/batch-sync', authenticateOptional, batchSyncResponses);

// ═════════════════════════════════════════════════════════════════════════
// PUBLIC — optional auth (mobile may or may not send a token)
// ═════════════════════════════════════════════════════════════════════════

// Submit response — public path used by mobile
router.post('/:tenantSlug/forms/:formId/responses', authenticateOptional, createResponse);

// Check chassis exists (public)
router.get('/form/:formId/identification-numbers', getFormIdentificationNumbers);
router.get('/:tenantSlug/forms/:formId/identification-numbers', getFormIdentificationNumbers);
router.get('/check-chassis', checkChassisExists);
router.get('/:tenantSlug/forms/:formId/check-chassis', checkChassisExists);

// Rank / suggestions / previous answers
router.get('/rank', authenticateOptional, getRank);
router.get('/:tenantSlug/forms/:formId/rank', authenticateOptional, getRank);
router.get('/suggestions', getSuggestedAnswers);
router.get('/:tenantSlug/forms/:formId/suggestions', getSuggestedAnswers);
router.get('/previous-answers', getQuestionPreviousAnswers);
router.get('/:tenantSlug/forms/:formId/previous-answers', getQuestionPreviousAnswers);

// ═════════════════════════════════════════════════════════════════════════
// PROTECTED ROUTES (require valid JWT)
// ═════════════════════════════════════════════════════════════════════════
router.use(authenticate);
router.use(addTenantFilter);

// Submit response — protected path used by web / internal callers
router.post('/:formId', createResponse);
router.post('/', createResponse);

// Batch import
router.post('/batch/import', batchImportResponses);

// Bulk auto-fill chassis
router.post('/form/:formId/auto-fill-chassis', autoFillChassisNumbers);

// Inspector / BIW / dispatch endpoints
router.get('/biw-summary', authenticate, getBiwSummary);
router.get('/unassigned', getUnassignedResponses);
router.patch('/bulk-biw-review', bulkUpdateBiwReview);
router.post('/biw-reviews/import', authenticate, bulkImportBiwExcelReviews);
router.post('/assign-multiple', assignResponses);

// Response management
router.get('/', cacheMiddleware(30), getAllResponses);
router.get('/:id', getResponseById);
router.put('/:id', updateResponse);
router.patch('/:id', updateResponse);
router.patch('/:id/assign', assignResponse);
router.delete('/:id', deleteResponse);
router.delete('/', deleteMultipleResponses);
router.post('/:responseId/auto-assign', autoAssignResponse);

// DEBUG
console.log('\n=== Registered Response Routes ===');
router.stack.forEach((layer) => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
    console.log(`${methods} ${layer.route.path}`);
  } else if (layer.name === 'router') {
    console.log(`Nested router at: ${layer.regexp}`);
  }
});
console.log('=== End Registered Routes ===\n');

export default router;