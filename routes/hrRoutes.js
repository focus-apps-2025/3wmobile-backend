import express from 'express';
import { authenticate, adminOnly, checkGranularPermission } from '../middleware/auth.js';
import { inspectorOnly } from '../middleware/inspectorOnly.js';
import * as shiftController from '../controllers/shiftController.js';
import * as attendanceController from '../controllers/attendanceController.js';
import * as reportController from '../controllers/reportController.js';
import * as leaveController from '../controllers/leaveController.js';
import * as permissionController from '../controllers/permissionController.js';
import * as notificationController from '../controllers/notificationController.js';
import { cacheMiddleware } from '../utils/cache.js';

const router = express.Router();

/**
 * SHIFT MANAGEMENT (Admin only)
 */
router.post('/shifts', authenticate, adminOnly, shiftController.createShift);
router.get('/shifts', authenticate, adminOnly, shiftController.getShifts);
router.get('/shifts/available-inspectors', authenticate, adminOnly, shiftController.getAvailableInspectors);
router.put('/shifts/:id', authenticate, adminOnly, shiftController.updateShift);
router.delete('/shifts/:id', authenticate, adminOnly, shiftController.deleteShift);
router.post('/shifts/:id/assign', authenticate, adminOnly, shiftController.assignInspectors);
router.delete('/shifts/:id/remove', authenticate, adminOnly, shiftController.removeInspectors);

/**
 * ATTENDANCE (Universal - all authenticated roles)
 */
router.post('/attendance/checkin', authenticate, attendanceController.checkIn);
router.post('/attendance/checkout', authenticate, attendanceController.checkOut);
router.post('/attendance/send-otp', authenticate, attendanceController.sendAttendanceOTP);
router.get('/attendance/my-status', authenticate, attendanceController.getMyStatus);
router.get('/attendance/my-history', authenticate, attendanceController.getMyHistory);
router.get('/attendance/my-monthly-summary', authenticate, attendanceController.getMyMonthlySummary);
router.get('/attendance/my-shift', authenticate, shiftController.getMyShift);

/**
 * LEAVE MANAGEMENT
 */
router.post('/leaves/apply', authenticate, inspectorOnly, leaveController.applyLeave);
router.get('/leaves/my', authenticate, inspectorOnly, leaveController.getMyLeaves);
router.get('/leaves/all', authenticate, adminOnly, leaveController.getAllLeaves);
router.put('/leaves/:id/status', authenticate, adminOnly, leaveController.updateLeaveStatus);

/**
 * PERMISSION MANAGEMENT
 */
router.post('/permissions/apply', authenticate, inspectorOnly, permissionController.applyPermission);
router.get('/permissions/my', authenticate, inspectorOnly, permissionController.getMyPermissions);
router.get('/permissions/all', authenticate, adminOnly, permissionController.getAllPermissions);
router.put('/permissions/:id/status', authenticate, adminOnly, permissionController.updatePermissionStatus);

/**
 * NOTIFICATIONS
 */
router.get('/notifications/my', authenticate, notificationController.getMyNotifications);
router.put('/notifications/:id/read', authenticate, notificationController.markAsRead);
router.put('/notifications/mark-all-read', authenticate, notificationController.markAllAsRead);
router.delete('/notifications/:id', authenticate, notificationController.deleteNotification);
router.delete('/notifications', authenticate, notificationController.deleteAllNotifications);

/**
 * REPORTS & STATS (Admin only)
 */
router.get('/attendance/report', authenticate, adminOnly, cacheMiddleware(30), reportController.getAttendanceReport);
router.get('/attendance/export', authenticate, adminOnly, reportController.exportAttendanceReport);
router.get('/attendance/summary', authenticate, adminOnly, cacheMiddleware(30), reportController.getTenantStats);

/**
 * CREATE ATTENDANCE (Admin with canEditAttendanceTime permission or SuperAdmin)
 */
router.post('/attendance/create', authenticate, checkGranularPermission('canEditAttendanceTime'), attendanceController.createAttendance);

/**
 * UPDATE ATTENDANCE TIME (Admin with canEditAttendanceTime permission or SuperAdmin)
 */
router.put('/attendance/:id/time', authenticate, checkGranularPermission('canEditAttendanceTime'), reportController.updateAttendanceTime);

export default router;