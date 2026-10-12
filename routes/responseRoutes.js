import express from 'express';
import {
  createResponse,
  batchImportResponses,
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
  getFormAttempts,
  batchSyncResponses
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
router.post('/reviews/bulk', getBulkReviewsForResponses);
router.get('/reviews/:responseId', getReviewsForResponse);
// Middleware for guest access control
const guestAccessControl = (req, res, next) => {
  if (req.user && req.user.isGuest) {
    const { formId } = req.params;
    if (formId && req.user.accessibleFormId !== formId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view data for your assigned form.'
      });
    }
    return next();
  }
  return next();
};

// DEBUG: Log when this router is loaded
console.log('Response router loaded');

// ========== PUBLIC & GUEST ROUTES ==========

// 1. Add a test route first
router.get('/test-route', (req, res) => {
  console.log('Test route hit!');
  res.json({ success: true, message: 'Test route works!' });
});

// 2. Form-specific responses (Allowed for guests)
router.get('/form/:formId', authenticateGuest, guestAccessControl, cacheMiddleware(30), getResponsesByForm);
router.get('/form/:formId/export', authenticateGuest, guestAccessControl, exportResponses);

// 3. BATCH IMPORT route - define it clearly

// 3. BULK IMAGE PROCESSING
router.post('/process-bulk-images', processBulkImages);

// 4. SINGLE IMAGE PROCESSING
router.post('/process-images', async (req, res) => {
  try {
    const { answers, submissionId } = req.body;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: answers object required'
      });
    }

    console.log('[PROCESS IMAGES] Converting Google Drive URLs to Cloudinary for preview');

    let processedAnswers = answers;
    try {
      const onProgress = submissionId ? (progressData) => {
        const io = req.app.get('io');
        if (io) {
          io.to(submissionId).emit('image-progress', {
            submissionId,
            status: progressData
          });
          console.log(`[PROGRESS] ${progressData.currentImage}/${progressData.totalImages}`);
        }
      } : null;

      processedAnswers = await processResponseImages(answers, onProgress);
      console.log('[PROCESS IMAGES] Successfully processed all images');
    } catch (error) {
      console.error('[PROCESS IMAGES] Failed to process images:', error.message);
      return res.status(400).json({
        success: false,
        message: 'Failed to process images: ' + error.message
      });
    }

    res.status(200).json({
      success: true,
      data: processedAnswers
    });

  } catch (error) {
    console.error('Process images error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during image processing'
    });
  }
});

// 5. SINGLE IMAGE CONVERSION
router.post('/convert-image', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: imageUrl (string) required'
      });
    }

    console.log('[CONVERT IMAGE] Converting single image URL to Cloudinary');

    const cloudinaryUrl = await processGoogleDriveImage(imageUrl, 'display');

    res.status(200).json({
      success: true,
      data: {
        cloudinaryUrl
      }
    });

  } catch (error) {
    console.error('Convert image error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during image conversion'
    });
  }
});

// 6. SINGLE RESPONSE CREATION (optional auth - allows public with token if provided)
router.post('/:tenantSlug/forms/:formId/responses', authenticateOptional, createResponse);

// 7. GET RANK (PUBLIC)
router.get('/rank', getRank);
router.get('/:tenantSlug/forms/:formId/rank', getRank);

// 8. GET SUGGESTIONS (PUBLIC)
router.get('/suggestions', getSuggestedAnswers);
router.get('/:tenantSlug/forms/:formId/suggestions', getSuggestedAnswers);

// 8b. GET ATTEMPTS & BATCH SYNC
router.get('/attempts/:formId', getFormAttempts);
router.get('/:tenantSlug/forms/:formId/attempts', getFormAttempts);
router.post('/batch-sync', authenticateOptional, batchSyncResponses);

// 9. GET PREVIOUS ANSWERS (PUBLIC)
router.get('/previous-answers', getQuestionPreviousAnswers);
router.get('/:tenantSlug/forms/:formId/previous-answers', getQuestionPreviousAnswers);



// ========== PROTECTED ROUTES (Require Auth) ==========
router.use(authenticate);
router.use(addTenantFilter);

router.post('/batch/import', batchImportResponses);

// Form-specific responses (Already defined in public section)
// router.get('/form/:formId', getResponsesByForm);
// router.get('/form/:formId/export', exportResponses);

// Bulk auto-fill: fills any response on this form whose chassis_number is
// missing/blank with the first configured chassis number, in one DB call.
router.post('/form/:formId/auto-fill-chassis', autoFillChassisNumbers);

// Specific routes MUST be registered before parameterized /:id routes
router.get('/biw-summary', authenticate, getBiwSummary);
router.get('/unassigned', getUnassignedResponses);
router.patch('/bulk-biw-review', bulkUpdateBiwReview);
router.post('/assign-multiple', assignResponses);

// Response management
router.get('/', cacheMiddleware(30), getAllResponses);
router.post('/', createResponse);
// Also handle POST /responses/:formId for internal submissions
router.post('/:formId', createResponse);
router.get('/:id', getResponseById);
router.put('/:id', updateResponse);
router.patch('/:id/assign', assignResponse);
router.delete('/:id', deleteResponse);
router.delete('/', deleteMultipleResponses);
router.post('/:responseId/auto-assign', autoAssignResponse);


// DEBUG: Log all registered routes
console.log('\n=== Registered Response Routes ===');
router.stack.forEach((layer) => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
    console.log(`${methods} ${layer.route.path}`);
  } else if (layer.name === 'router') {
    // This is a nested router
    console.log(`Nested router at: ${layer.regexp}`);
  }
});
console.log('=== End Registered Routes ===\n');

export default router;