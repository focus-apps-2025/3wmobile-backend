import express from 'express';
import {
  uploadFile,
  getFile,
  deleteFile,
  getFilesByUser,
  getFileInfo,
  proxyFile
} from '../controllers/fileController.js';
import { authenticate, authenticateOptional } from '../middleware/auth.js';
import upload from '../middleware/upload.js';

const router = express.Router();

// Public file access
router.get('/proxy', proxyFile);
router.get('/:filename', getFile);

router.post('/upload', authenticateOptional, upload.single('file'), uploadFile);

// Protected routes
router.use(authenticate);

// File management
router.get('/', getFilesByUser);
router.get('/info/:id', getFileInfo);
router.delete('/:id', deleteFile);

export default router;