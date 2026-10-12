import express from 'express';
import {
  getImportHistory,
  getImportHistoryStats,
  deleteImportHistory,
  getImportHistoryResponses
} from '../controllers/importHistoryController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Routes require authentication
router.get('/', authenticate, getImportHistory);
router.get('/stats', authenticate, getImportHistoryStats);
router.get('/:id/responses', authenticate, getImportHistoryResponses);
router.delete('/:id', authenticate, deleteImportHistory);

export default router;
