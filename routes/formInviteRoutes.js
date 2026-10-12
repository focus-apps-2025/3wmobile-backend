import express from 'express';
import multer from 'multer';
import {
  uploadInvites,
  sendInvites,
  sendSMSInvites,
  getInviteStats,
  getInviteList
} from '../controllers/formInviteController.js';
import {
  uploadWhatsAppInvites,
  sendWhatsAppInvites
} from '../controllers/whatsappController.js';
import { authenticate, teacherOrAdmin } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only Excel/CSV files are allowed'), false);
    }
  }
});

// Admin middleware (you need to create this)
const adminOnly = (req, res, next) => {
  if (
    req.user.role === 'admin' ||
    req.user.role === 'superadmin' ||
    req.user.role === 'subadmin' ||
    req.user.role === 'inspector'
  ) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: 'Admin, Subadmin, or Inspector access required'
    });
  }
};

// Routes
router.post('/:formId/invites/upload',
  authenticate,
  adminOnly,
  upload.single('file'),
  uploadInvites
);

router.post('/:formId/invites/send',
  authenticate,
  adminOnly,
  sendInvites
);

router.post('/:formId/invites/whatsapp/upload',
  authenticate,
  adminOnly,
  upload.single('file'),
  uploadWhatsAppInvites
);

router.post('/:formId/invites/whatsapp/send',
  authenticate,
  adminOnly,
  sendWhatsAppInvites
);

// SMS routes
router.post('/:formId/invites/sms/send',
  authenticate,
  adminOnly,
  sendSMSInvites
);

router.get('/:formId/invites/stats',
  authenticate,
  adminOnly,
  getInviteStats
);
// Add to your formInviteRoutes.js
router.get('/:formId/invites',
  authenticate,
  adminOnly,
  getInviteList
);

export default router;