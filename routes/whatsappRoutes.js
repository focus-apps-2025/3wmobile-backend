import express from 'express';
import { 
  sendServiceRequestNotification, 
  sendStatusUpdate, 
  testWhatsAppConnection, 
  sendTestWhatsAppMessage,
  sendResponseReport,
  testResponseReportWhatsApp
} from '../controllers/whatsappController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/test-connection', authenticate, authorize('admin'), testWhatsAppConnection);

router.post('/test-message', authenticate, authorize('admin'), sendTestWhatsAppMessage);

router.post('/test-response-report', authenticate, authorize('admin'), testResponseReportWhatsApp);

router.post('/service-request-notification', sendServiceRequestNotification);

router.post('/status-update', authenticate, authorize('admin'), sendStatusUpdate);

router.post('/send-response-report', authenticate, authorize('admin', 'superadmin', 'teacher'), sendResponseReport);

export default router;
