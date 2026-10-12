import express from 'express';
import {
  createTenant,
  getAllTenants,
  getTenantsMinimal,
  getTenantBySlug,
  updateTenant,
  toggleTenantStatus,
  deleteTenant,
  getTenantStats,
  addAdminToTenant,
  removeAdminFromTenant,
  getGlobalDefaultLogo,
  updateGlobalDefaultLogo,
  removeGlobalDefaultLogo,
  getOfficeLocation,
  updateOfficeLocation
} from '../controllers/tenantController.js';
import { authenticate, superAdminOnly, adminOnly } from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);
router.use(addTenantFilter);

// Office location management (must come before parameterized routes)
router.get('/office-location', authenticate, getOfficeLocation);
router.put('/office-location', adminOnly, updateOfficeLocation);

// Global default logo management (SuperAdmin only)
router.get('/global/default-logo', superAdminOnly, getGlobalDefaultLogo);
router.put('/global/default-logo', superAdminOnly, updateGlobalDefaultLogo);
router.delete('/global/default-logo', superAdminOnly, removeGlobalDefaultLogo);

// SuperAdmin-only routes for tenant management
router.get('/minimal', getTenantsMinimal); // Minimal list accessible to all authenticated users
router.post('/', superAdminOnly, createTenant);
router.get('/', superAdminOnly, getAllTenants);
router.get('/slug/:slug', superAdminOnly, getTenantBySlug);
router.put('/:id', superAdminOnly, updateTenant);
router.patch('/:id/toggle-status', superAdminOnly, toggleTenantStatus);
router.delete('/:id', superAdminOnly, deleteTenant);

// Admin and SuperAdmin can manage tenant admins
router.get('/:id/stats', adminOnly, getTenantStats);
router.post('/:tenantId/add-admin', adminOnly, addAdminToTenant);
router.delete('/:tenantId/remove-admin/:adminId', adminOnly, removeAdminFromTenant);

// Global default logo management (SuperAdmin only)
router.get('/global/default-logo', superAdminOnly, getGlobalDefaultLogo);
router.put('/global/default-logo', superAdminOnly, updateGlobalDefaultLogo);
router.delete('/global/default-logo', superAdminOnly, removeGlobalDefaultLogo);

export default router;