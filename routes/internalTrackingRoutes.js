import express from 'express';
import {
  updateInternalTrackingSettings,
  getInternalTrackingSettings,
  checkInternalTrackingAccess,
  getInternalTrackingPerformance,
  getTenantPerformanceDetails
} from '../controllers/internalTrackingController.js';
import { authenticate, superAdminOnly, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Check if current user has access (any authenticated user)
router.get('/check-access', checkInternalTrackingAccess);

// Get performance data for allowed tenants (admin+ with internal tracking access)
router.get('/performance', adminOnly, getInternalTrackingPerformance);

// Get detailed performance data for a specific tenant
router.get('/tenant/:tenantId/performance', adminOnly, getTenantPerformanceDetails);

// Get settings for a tenant
router.get('/:tenantId', getInternalTrackingSettings);

// SuperAdmin can update settings for any tenant
router.put('/:tenantId', superAdminOnly, updateInternalTrackingSettings);

export default router;
