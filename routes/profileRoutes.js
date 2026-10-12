import express from 'express';
import {
  getProfile,
  updateProfile,
  updateSettings,
  uploadAvatar
} from '../controllers/profileController.js';
import { authenticate } from '../middleware/auth.js';
import upload from '../middleware/upload.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Profile routes
router.get('/', getProfile);
router.get('/:userId', getProfile);
router.put('/', updateProfile);
router.put('/:userId', updateProfile);

// Settings
router.patch('/settings', updateSettings);

// Avatar upload
router.post('/avatar', upload.single('avatar'), uploadAvatar);

export default router;