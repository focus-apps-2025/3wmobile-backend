import express from 'express';
import { 
  sendMessage, 
  getMessagesByResponse, 
  getMyMessages, 
  getTenantMessages,
  replyToMessage,
  fixMessagesToEmail
} from '../controllers/messageController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticate);

router.post('/send', sendMessage);
router.get('/response/:responseId', getMessagesByResponse);
router.get('/my-messages', getMyMessages);
router.get('/tenant-messages', getTenantMessages);
router.post('/reply', replyToMessage);
router.post('/fix-toemail', fixMessagesToEmail);

export default router;
