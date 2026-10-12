import express from 'express';
import {
    getAttendance,
    getAttendanceSummary,
    updateLastActive,
    getMyAttendance,
    getMyMonthlySummary,
    exportAttendance,
    getAttendanceUsers,
    updateLoginLocation,
    createAttendance,
    getInspectors,
    swapResponses,
    updateAttendanceTime
} from '../controllers/attendanceController.js';
import { authenticate, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// @route   GET /api/attendance
// @desc    Get attendance records (filtered by role)
// @access  Private
router.get('/', getAttendance);

// @route   GET /api/attendance/summary
// @desc    Get attendance summary for dashboard
// @access  Private
router.get('/summary', getAttendanceSummary);

// @route   GET /api/attendance/my
// @desc    Get current user's attendance history
// @access  Private
router.get('/my', getMyAttendance);

// @route   GET /api/attendance/my-monthly-summary
// @desc    Get current user's monthly attendance and working hours summary
// @access  Private
router.get('/my-monthly-summary', getMyMonthlySummary);

// @route   GET /api/attendance/users
// @desc    Get all users for attendance management
// @access  Private (Superadmin, Admin)
router.get('/users', getAttendanceUsers);

// @route   GET /api/attendance/export
// @desc    Export attendance data for Excel
// @access  Private
router.get('/export', exportAttendance);

// @route   POST /api/attendance/heartbeat
// @desc    Update last active time (heartbeat)
// @access  Private
router.post('/heartbeat', updateLastActive);

// @route   PUT /api/attendance/login-location
// @desc    Update login location info
// @access  Private
router.put('/login-location', updateLoginLocation);

// @route   POST /api/attendance/create
// @desc    Create attendance record (Admin/HR)
// @access  Private (Admin only)
router.post('/create', createAttendance);

// @route   GET /api/attendance/inspectors
// @desc    Get all inspectors for swapping target selection
// @access  Private (Admin only)
router.get('/inspectors', adminOnly, getInspectors);

// @route   POST /api/attendance/swap-responses
// @desc    Swap responses between inspectors and log it
// @access  Private (Admin only)
router.post('/swap-responses', adminOnly, swapResponses);
// @route   PUT /api/attendance/:id/time
// @desc    Update attendance time (Admin only)
// @access  Private (Admin only)
router.put('/:id/time', authenticate, adminOnly, updateAttendanceTime);

export default router;
