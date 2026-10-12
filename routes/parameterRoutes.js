import express from 'express';
import {
  createParameter,
  getAllParameters,
  getParameterById,
  updateParameter,
  deleteParameter
} from '../controllers/parameterController.js';
import { authenticate } from '../middleware/auth.js';
import { addTenantFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);
router.use(addTenantFilter);

// @route   POST /api/parameters
// @desc    Create a new parameter
// @access  Private
router.post('/', createParameter);

// @route   GET /api/parameters
// @desc    Get all parameters with optional filtering
// @access  Private
router.get('/', getAllParameters);

// @route   GET /api/parameters/:id
// @desc    Get parameter by ID
// @access  Private
router.get('/:id', getParameterById);

// @route   PUT /api/parameters/:id
// @desc    Update parameter
// @access  Private
router.put('/:id', updateParameter);

// @route   DELETE /api/parameters/:id
// @desc    Delete parameter
// @access  Private
router.delete('/:id', deleteParameter);

export default router;