import express from 'express';
import {
  createRole,
  getAllRoles,
  getRoleById,
  updateRole,
  deleteRole,
  assignRoleToUser,
  getUsersByRole,
  getAvailablePermissions
} from '../controllers/roleController.js';
import { authenticate, adminOnly } from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();

// All routes require authentication and admin privileges
router.use(authenticate);
router.use(addTenantFilter);
router.use(adminOnly);

// Role management
router.post('/', createRole);
router.get('/', getAllRoles);
router.get('/permissions', getAvailablePermissions);
router.get('/:id', getRoleById);
router.put('/:id', updateRole);
router.delete('/:id', deleteRole);

// User-role assignment
router.post('/assign', assignRoleToUser);
router.get('/:roleId/users', getUsersByRole);

export default router;