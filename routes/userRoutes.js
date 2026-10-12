import express from 'express';
import {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  resetUserPassword,
  getAvailableAdmins,
  getUserActivityLogs,
  getUsersHierarchy,
  getAllTenantsPerformance,
  getPerformanceScores,
  submitReview,
  getReviewsForResponse, updateGranularPermissions
} from '../controllers/userController.js';
import { authenticate, adminOnly, inspectorOrAdmin, authorize } from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';
import { validateUserCreation } from '../middleware/validation.js';


const router = express.Router();

// All routes require authentication and admin privileges
router.get('/reviews/:responseId', getReviewsForResponse);


router.use(authenticate);

// Performance scores routes - bypass tenant filter for cross-tenant visibility
router.get('/performance-scores', inspectorOrAdmin, getPerformanceScores);

// @route   POST /api/users/reviews
// @desc    Submit a review
// @access  Private (Admin, SuperAdmin, SubAdmin, Inspector)
router.post('/reviews', authorize('admin', 'superadmin', 'subadmin', 'inspector'), submitReview);

router.use(addTenantFilter);
router.use(adminOnly);

// @route   POST /api/users
// @desc    Create a new user
// @access  Private (Admin only)
router.post('/', validateUserCreation, createUser);

// @route   GET /api/users
// @desc    Get all users with pagination and filtering
// @access  Private (Admin only)
router.get('/', getAllUsers);

// Add these new routes
router.get('/available-admins', getAvailableAdmins);
router.get('/activity-logs', getUserActivityLogs); // Fixed: Added route matching frontend endpoint
router.get('/:userId/activity', getUserActivityLogs);
router.get('/hierarchy', getUsersHierarchy);

// SuperAdmin route - get all tenants performance (must be BEFORE /:id to avoid conflict)
router.get('/all-tenants-performance', getAllTenantsPerformance);

// Performance scores routes - bypass tenant filter for cross-tenant visibility
// @route   GET /api/users/performance-scores
// @desc    Get all performance scores
// @access  Private (Admin only)



// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private (Admin only)
router.get('/:id', getUserById);

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private (Admin only)
router.put('/:id', updateUser);

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private (Admin only)
router.delete('/:id', deleteUser);

// @route   PUT /api/users/:id/reset-password
// @desc    Reset user password
// @access  Private (Admin only)
router.put('/:id/reset-password', resetUserPassword);

// @route   PUT /api/users/:id/granular-permissions
// @desc    Update granular permissions for a user (SuperAdmin only)
// @access  Private (SuperAdmin only)
router.put('/:id/granular-permissions', authorize('superadmin'), updateGranularPermissions);

export default router;
