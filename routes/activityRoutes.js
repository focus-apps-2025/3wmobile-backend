// routes/activityRoutes.js
import express from 'express';
import { authenticate as auth } from '../middleware/auth.js';
import { ensureTenantIsolation } from '../middleware/tenantIsolation.js';
import { trackAction, recordHeartbeat } from '../middleware/activityTracker.js';
import {
  getTenantActivitySummary,
  getUserTimeline,
  getFormFillingAnalytics
} from '../controllers/activityController.js';

const router = express.Router();

// All routes require authentication
router.use(auth);
router.use(ensureTenantIsolation);

// Heartbeat for continuous tracking
router.post('/heartbeat', recordHeartbeat);

// Activity analytics
router.get('/tenant/:tenantId/summary', getTenantActivitySummary);
router.get('/user/:userId/timeline', getUserTimeline);
router.get('/forms/:formId/sessions', getFormFillingAnalytics);

export default router;