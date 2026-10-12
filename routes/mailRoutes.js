import express from 'express';
import fileUpload from 'express-fileupload';
import { 
  sendServiceRequestNotification, 
  sendStatusUpdate, 
  testMailConnection, 
  sendTestEmail,
  sendResponseReport,
  testResponseReportEmail
} from '../controllers/mailController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();
const uploadMiddleware = fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } });

// Test mail connection (admin only)
router.get('/test-connection', authenticate, authorize('admin'), testMailConnection);

// Send test email (admin only)
router.post('/test-email', authenticate, authorize('admin'), sendTestEmail);

// Test response report email (admin only)
router.post('/test-response-report', authenticate, authorize('admin'), testResponseReportEmail);

// Send service request notification (public route - called when form is submitted)
router.post('/service-request-notification', sendServiceRequestNotification);

// Send status update to customer (admin only)
router.post('/status-update', authenticate, authorize('admin'), sendStatusUpdate);

// Send response report via email (admin, superadmin, and teacher)
router.post('/send-response-report', authenticate, authorize('admin', 'superadmin', 'teacher'), uploadMiddleware, sendResponseReport);

export default router;