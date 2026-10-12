import express from 'express';
import multer from 'multer';
import {
  uploadAnalyticsInvites,
  sendAnalyticsInvites,
  requestGuestOTP,
  verifyAnalyticsOTP
} from '../controllers/analyticsInviteController.js';
import { authenticate, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1
  }
});

// Guest Login (Public)
router.post('/request-otp', requestGuestOTP);
router.post('/verify-otp', verifyAnalyticsOTP);

// Admin Management (Protected)
router.post('/:formId/upload',
  authenticate,
  adminOnly,
  upload.single('file'),
  uploadAnalyticsInvites
);

router.post('/:formId/send',
  authenticate,
  adminOnly,
  sendAnalyticsInvites
);

export default router;
