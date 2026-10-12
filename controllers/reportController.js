import Attendance from '../models/Attendance.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import { processAttendanceForReport, generateAttendanceExcel } from '../services/reportService.js';

/**
 * Generate attendance report with filters
 */
export const getAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, inspectorId, status, shiftId, role } = req.query;
    const userRole = req.user.role;
    const tenantId = req.user.tenantId;

    console.log('=== getAttendanceReport ===');
    console.log('User role:', userRole);
    console.log('User email:', req.user.email);
    console.log('tenantId:', tenantId);
    console.log('startDate:', startDate, 'endDate:', endDate, 'filterRole:', role);

    // 1. Build Query
    let query = {};

    if (userRole === 'superadmin') {
      // Superadmin sees all tenants, no tenant filter
    } else if (tenantId) {
      query.tenantId = tenantId;
    }

    // Parse dates in LOCAL timezone to match stored Attendance.date
    const parseLocalDate = (dateStr) => {
      const parts = dateStr.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    };

    const now = new Date();
    const start = startDate ? parseLocalDate(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate ? parseLocalDate(endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    query.date = { $gte: start, $lte: end };

    if (inspectorId) query.inspector = inspectorId;
    if (status) query.status = status;
    if (shiftId) query.shift = shiftId;

    console.log('Final query:', JSON.stringify(query));

    // User filter for roster (all users or filtered by role)
    const userFilter = { isActive: true };
    if (role && role !== 'all') {
      userFilter.role = role;
    } else {
      userFilter.role = { $in: ['admin', 'subadmin', 'inspector', 'user'] };
    }

    // 2. Fetch Data in parallel using lean() for maximum query speed
    const [rawLogs, inspectors] = await Promise.all([
      Attendance.find(query)
        .populate('inspector', 'firstName lastName username email role tenantId')
        .populate('tenantId', 'name companyName')
        .populate('shift', 'name displayName startTime endTime')
        .sort({ date: -1 })
        .lean(),
      userRole === 'superadmin'
        ? User.find(userFilter).select('firstName lastName username email role').lean()
        : User.find({ tenantId, ...userFilter }).select('firstName lastName username email role').lean()
    ]);

    // If a specific role was requested, filter logs to only include users with that role
    const logs = (role && role !== 'all')
      ? rawLogs.filter(l => l.inspector && l.inspector.role === role)
      : rawLogs;

    // 3. Process Report
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    const reportData = processAttendanceForReport(logs, inspectors, totalDays);
    console.log('Report data structure:', Object.keys(reportData));
    console.log('detailedLogs count:', reportData.detailedLogs?.length);

    res.json({ success: true, data: reportData });
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Export attendance report to Excel
 */
export const exportAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, inspectorId, status, shiftId, role } = req.query;
    const userRole = req.user.role;
    const tenantId = req.user.tenantId;

    // 1. Fetch Tenant info
    const tenant = tenantId ? await Tenant.findById(tenantId) : null;
    
    // 2. Build Query & Fetch Logs
    const query = {};
    if (userRole !== 'superadmin' && tenantId) {
      query.tenantId = tenantId;
    }
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
      console.log('exportAttendanceReport - date query:', query.date);
    }
    if (inspectorId) query.inspector = inspectorId;
    if (status) query.status = status;
    if (shiftId) query.shift = shiftId;

    const rawLogs = await Attendance.find(query)
      .populate('inspector', 'firstName lastName username email role')
      .populate('shift', 'name displayName startTime endTime')
      .sort({ date: -1 });

    const userFilter = { isActive: true };
    if (role && role !== 'all') {
      userFilter.role = role;
    } else {
      userFilter.role = { $in: ['admin', 'subadmin', 'inspector', 'user'] };
    }

    const inspectors = await User.find(
      userRole === 'superadmin' ? userFilter : { tenantId, ...userFilter }
    ).select('firstName lastName username email role').lean();

    const logs = (role && role !== 'all')
      ? rawLogs.filter(l => l.inspector && l.inspector.role === role)
      : rawLogs;

    // 3. Process Data
    const diffTime = Math.abs(new Date(endDate) - new Date(startDate));
    const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    const reportData = processAttendanceForReport(logs, inspectors, totalDays);

    // 4. Generate Excel
    const buffer = generateAttendanceExcel(reportData, {
      tenantName: tenant.companyName || tenant.name,
      startDate,
      endDate,
      summary: reportData.summary
    });

    // 5. Send File
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_report_${startDate}_${endDate}.xlsx`);
    res.send(buffer);

  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get tenant-wide statistics for dashboard
 */
export const getTenantStats = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const logsToday = await Attendance.find({
      tenantId,
      date: { $gte: today }
    });

    const totalInspectors = await User.countDocuments({
      tenantId,
      role: 'inspector',
      isActive: true
    });

    const stats = {
      totalInspectors,
      present: logsToday.length,
      absent: Math.max(0, totalInspectors - logsToday.length),
      late: logsToday.filter(l => l.status === 'late').length,
      halfDay: logsToday.filter(l => l.status === 'half-day').length
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Update attendance time (SuperAdmin grants permission via granularPermissions)
 */
export const updateAttendanceTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { checkIn, checkOut, status, shift } = req.body;

    // Only superadmin can update attendance times via this endpoint
    // Admin users need granular permission canEditAttendanceTime=true
    if (req.user.role === 'admin') {
      const user = await User.findById(req.user._id);
      if (!user?.granularPermissions?.canEditAttendanceTime) {
        return res.status(403).json({
          success: false,
          message: 'Permission denied. Admin does not have "Can Edit Attendance" permission.'
        });
      }
    }

    const attendance = await Attendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }

    if (checkIn) {
      attendance.checkInTime = new Date(checkIn);
    }
    if (checkOut) {
      attendance.checkOutTime = new Date(checkOut);
    }

    // Update status if provided
    if (status) {
      attendance.status = status;
      attendance.isPresent = status === 'present' || status === 'late' || status === 'half-day';
    }

    // Update shift name if provided
    if (shift) {
      attendance.shiftName = shift;
    }

    // Recalculate working hours
    if (attendance.checkInTime && attendance.checkOutTime) {
      attendance.workingHours = (attendance.checkOutTime.getTime() - attendance.checkInTime.getTime()) / (1000 * 60 * 60);
      attendance.workingHours = Math.round(attendance.workingHours * 100) / 100;
    }

    await attendance.save();
    res.json({ success: true, data: attendance });
  } catch (error) {
    console.error('Update attendance time error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
