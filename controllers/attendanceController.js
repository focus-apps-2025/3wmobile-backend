import Attendance from '../models/Attendance.js';
import Shift from '../models/Shift.js';
import User from '../models/User.js';
import Response from '../models/Response.js';
import Form from '../models/Form.js';
import SwapLog from '../models/SwapLog.js';
import { reverseGeocode } from '../utils/geocode.js';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import smsService from '../services/smsService.js';
import { v4 as uuidv4 } from 'uuid';

// Helper to get current IST time
const getISTNow = () => {
  // This works regardless of server timezone (local or production)
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
};

// Helper to get today's date boundary in IST (Midnight IST)
const getISTToday = () => {
  const istNow = getISTNow();
  istNow.setHours(0, 0, 0, 0);
  return istNow;
};

const getISTDate = () => {
  const istNow = getISTNow();
  istNow.setHours(0, 0, 0, 0);
  return istNow;
};

// Helper to convert HH:mm to minutes
const toMins = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Centered Shift Detection Logic with Buffer
 */
const findShiftByTime = (currentMins, shifts, bufferMins = 15) => {
  console.log(`findShiftByTime - currentMins: ${currentMins}, shiftsCount: ${shifts.length}, buffer: ${bufferMins}`);

  return shifts.find(s => {
    const startMins = toMins(s.startTime);
    const endMins = toMins(s.endTime);
    const isNight = s.isNightShift || startMins > endMins;

    // Buffer allows checking in slightly before the shift starts
    const bufferedStart = (startMins - bufferMins + 1440) % 1440;

    let isMatch = false;
    if (isNight) {
      if (bufferedStart > endMins) {
        isMatch = currentMins >= bufferedStart || currentMins < endMins;
      } else {
        isMatch = currentMins >= bufferedStart && currentMins < endMins;
      }
    } else {
      if (bufferedStart > endMins) {
        isMatch = currentMins >= bufferedStart || currentMins < endMins;
      } else {
        isMatch = currentMins >= bufferedStart && currentMins < endMins;
      }
    }

    console.log(`Checking shift ${s.displayName || s.name} (${s.startTime}-${s.endTime}): bufferedStart=${bufferedStart}, endMins=${endMins}, isNight=${isNight} -> Match: ${isMatch}`);
    return isMatch;
  });
};

/**
 * Check-in process for inspectors (HRM Logic)
 */
export const checkIn = async (req, res) => {
  try {
    const { lat, lng, accuracy, otp } = req.body;
    const inspectorId = req.user._id;
    let tenantId = req.user.tenantId;
    if (!tenantId) {
      try {
        const Tenant = mongoose.model('Tenant');
        const firstTenant = await Tenant.findOne({ isActive: true }) || await Tenant.findOne();
        if (firstTenant) {
          tenantId = firstTenant._id;
        }
      } catch (err) {
        console.warn('Could not resolve fallback tenantId:', err.message);
      }
    }

    // Verify OTP if provided
    if (otp) {
      const user = await User.findById(inspectorId);
      if (user.attendanceOTP !== otp) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
      }
      // Clear OTP after use
      user.attendanceOTP = null;
      user.attendanceOTPVerified = true;
      await user.save();
    }

    // 2. Check for existing attendance today
    const now = getISTNow();
    const today = getISTToday();

    let existingAttendance = await Attendance.findOne({
      inspector: inspectorId,
      date: { $gte: today }
    });

    if (existingAttendance && existingAttendance.checkInTime && !existingAttendance.checkOutTime) {
      return res.status(400).json({ success: false, message: 'Already checked in' });
    }

    // 2.5 Auto Shift Detection based on current IST punch time
    const allShifts = tenantId ? await Shift.find({ tenantId, isActive: true }) : await Shift.find({ isActive: true });
    const currentMins = now.getHours() * 60 + now.getMinutes();

    let shift = findShiftByTime(currentMins, allShifts, 30); // 30 mins buffer for smooth punch-in window

    // Overtime/Fallback Shift lookup
    if (!shift && existingAttendance && existingAttendance.shift) {
      shift = await Shift.findById(existingAttendance.shift);
    }
    if (!shift && tenantId) {
      shift = await Shift.findOne({
        tenantId,
        assignedInspectors: inspectorId,
        isActive: true
      });
    }
    if (!shift && tenantId) {
      // Fallback to any active shift for this tenant to avoid blocking the user
      shift = await Shift.findOne({ tenantId, isActive: true });
    }
    if (!shift) {
      shift = await Shift.findOne({ isActive: true });
    }

    // Auto-provision a default General Shift if no shift exists yet
    if (!shift && tenantId) {
      try {
        shift = await Shift.create({
          tenantId,
          name: 'general',
          displayName: 'General Shift (09:00 - 18:00)',
          startTime: '09:00',
          endTime: '18:00',
          gracePeriod: 15,
          lateMarkingAfter: 30,
          halfDayMarkingAfter: 120,
          isActive: true,
          assignedInspectors: [inspectorId]
        });
        console.log('Auto-created standard General Shift for tenant:', tenantId);
      } catch (shiftErr) {
        console.warn('Failed to auto-create shift:', shiftErr.message);
      }
    }

    if (!shift) {
      return res.status(400).json({
        success: false,
        message: 'No shift available for current time. Please configure an active shift.'
      });
    }

    // Automatically bind user to the matched shift if not already assigned
    if (shift && (!shift.assignedInspectors || !shift.assignedInspectors.some(id => id.toString() === inspectorId.toString()))) {
      shift.assignedInspectors = shift.assignedInspectors || [];
      shift.assignedInspectors.push(inspectorId);
      await shift.save().catch(e => console.warn('Could not auto-bind user to shift:', e.message));
    }

    // 3. Validate timing against shift (Late/Half-day marking) - only if it's the FIRST check-in today
    let status = 'present';
    let isLate = false;
    let isHalfDay = false;

    if (existingAttendance && existingAttendance.checkInTime) {
      // Preserve first check-in details for status
      status = existingAttendance.status;
      isLate = existingAttendance.isLate;
      isHalfDay = existingAttendance.isHalfDay;
    } else {
      const shiftStartMins = toMins(shift.startTime);
      const shiftEndMins = toMins(shift.endTime);

      // Calculate diff for status marking
      let diff;
      if (shift.isNightShift || shiftStartMins > shiftEndMins) {
        if (currentMins >= shiftStartMins) {
          diff = currentMins - shiftStartMins;
        } else if (currentMins < shiftEndMins) {
          // Checked in after midnight
          diff = currentMins + (1440 - shiftStartMins);
        } else {
          // Within the buffer before start (e.g. 21:50 for 22:00 start)
          diff = currentMins - shiftStartMins;
        }
      } else {
        diff = currentMins - shiftStartMins;
      }

      if (diff > shift.halfDayMarkingAfter) {
        status = 'half-day';
        isHalfDay = true;
      } else if (diff > shift.lateMarkingAfter) {
        status = 'late';
        isLate = true;
      }
    }

    const place = await reverseGeocode(lat, lng);

    const attendanceData = {
      inspector: inspectorId,
      tenantId,
      shift: shift._id,
      shiftName: shift.displayName,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      date: today,
      checkInTime: now,
      checkInLat: lat,
      checkInLng: lng,
      checkInPlace: place || 'Position Captured',
      checkInAccuracy: accuracy,
      status,
      isLate,
      isHalfDay,
      checkOutTime: null,
      checkOutLat: null,
      checkOutLng: null,
      checkOutPlace: null,
      checkOutAccuracy: null
    };

    console.log('checkIn - creating/updating attendance:', attendanceData);

    const newPunch = {
      type: 'in',
      time: now,
      lat,
      lng,
      place: attendanceData.checkInPlace,
      accuracy
    };

    if (existingAttendance) {
      // If we are checking in again, preserve the accumulated workingHours
      const accumulatedHours = existingAttendance.workingHours || 0;
      Object.assign(existingAttendance, attendanceData);
      existingAttendance.workingHours = accumulatedHours;
      if (!existingAttendance.punches) {
        existingAttendance.punches = [];
      }
      existingAttendance.punches.push(newPunch);
      await existingAttendance.save();
      console.log('checkIn - updated existing attendance:', existingAttendance);
    } else {
      attendanceData.punches = [newPunch];
      existingAttendance = await Attendance.create(attendanceData);
      console.log('checkIn - created new attendance:', existingAttendance);
    }

    res.status(201).json({ success: true, data: existingAttendance });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Check-out process for inspectors (HRM Logic)
 */
export const checkOut = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const inspectorId = req.user._id;
    const tenantId = req.user.tenantId;
    const now = getISTNow();
    const today = getISTToday();

    const attendance = await Attendance.findOne({
      inspector: inspectorId,
      date: { $gte: today },
      checkInTime: { $exists: true },
      checkOutTime: null
    }).populate('shift');

    if (!attendance) {
      return res.status(400).json({ success: false, message: 'No active check-in found for today' });
    }

    const place = await reverseGeocode(lat, lng);

    attendance.checkOutTime = now;
    attendance.checkOutLat = lat;
    attendance.checkOutLng = lng;
    attendance.checkOutPlace = place || 'Position Captured';
    attendance.checkOutAccuracy = accuracy;

    // Calculate working hours and add to previously accumulated hours
    const workingHoursMs = attendance.checkOutTime - attendance.checkInTime;
    const currentSessionHours = parseFloat((workingHoursMs / (1000 * 60 * 60)).toFixed(2));
    attendance.workingHours = parseFloat(((attendance.workingHours || 0) + currentSessionHours).toFixed(2));

    const shiftEndStr = attendance.shiftEndTime || attendance.shift?.endTime;
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const shiftEndMins = toMins(shiftEndStr);

    const isNight = attendance.shift?.isNightShift || (shiftEndStr && toMins(attendance.shiftStartTime) > shiftEndMins);

    if (shiftEndMins) {
      if (isNight) {
        const startMins = toMins(attendance.shiftStartTime);
        if (currentMins < shiftEndMins) {
          attendance.isEarlyCheckout = false;
        } else if (currentMins >= startMins) {
          attendance.isEarlyCheckout = true;
        } else {
          attendance.isEarlyCheckout = false;
        }
      } else {
        if (currentMins < shiftEndMins) {
          attendance.isEarlyCheckout = true;
        } else {
          attendance.isEarlyCheckout = false;
        }
      }
    }

    // Update status based on working hours
    if (attendance.workingHours < 4) {
      attendance.status = 'half-day';
      attendance.isHalfDay = true;
    } else {
      attendance.isHalfDay = false;
      if (attendance.isLate) {
        attendance.status = 'late';
      } else {
        attendance.status = 'present';
      }
    }

    // Explicitly mark workingHours as modified to skip the pre-save recalculation hook
    attendance.markModified('workingHours');

    const newPunch = {
      type: 'out',
      time: now,
      lat,
      lng,
      place: attendance.checkOutPlace,
      accuracy
    };
    if (!attendance.punches) {
      attendance.punches = [];
    }
    attendance.punches.push(newPunch);

    await attendance.save();

    res.json({ success: true, data: attendance });
  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get today's status for the inspector
 */
export const getMyStatus = async (req, res) => {
  try {
    const inspectorId = req.user._id;
    let tenantId = req.user.tenantId;
    if (!tenantId) {
      try {
        const Tenant = mongoose.model('Tenant');
        const firstTenant = await Tenant.findOne({ isActive: true }) || await Tenant.findOne();
        if (firstTenant) {
          tenantId = firstTenant._id;
        }
      } catch (err) {
        console.warn('Could not resolve fallback tenantId:', err.message);
      }
    }

    console.log('getMyStatus - inspectorId:', inspectorId, 'tenantId:', tenantId);

    const today = getISTToday();
    const now = getISTNow();

    const attendance = await Attendance.findOne({
      inspector: inspectorId,
      date: { $gte: today }
    });

    // Auto Shift Detection for "Potential" shift if not checked in
    let shift = null;
    if (attendance && attendance.shift) {
      shift = await Shift.findById(attendance.shift);
    } else {
      const allShifts = tenantId ? await Shift.find({ tenantId, isActive: true }) : await Shift.find({ isActive: true });
      const currentMins = now.getHours() * 60 + now.getMinutes();
      console.log(`getMyStatus - current IST: ${now.toString()}, currentMins: ${currentMins}, shifts found: ${allShifts.length}`);
      shift = findShiftByTime(currentMins, allShifts, 30);
      
      if (!shift && tenantId) {
        shift = await Shift.findOne({
          tenantId,
          assignedInspectors: inspectorId,
          isActive: true
        });
      }
      if (!shift && tenantId) {
        shift = await Shift.findOne({ tenantId, isActive: true });
      }
      if (!shift) {
        shift = await Shift.findOne({ isActive: true });
      }
    }

    // Let them check in if they have not checked in yet today, OR if they have checked out and can check in again
    let canCheckIn = !!shift && (!attendance || !attendance.checkInTime || !!attendance.checkOutTime);
    let canCheckOut = !!attendance && !!attendance.checkInTime && !attendance.checkOutTime;

    res.json({
      success: true,
      data: {
        shift,
        attendance,
        canCheckIn,
        canCheckOut
      }
    });
  } catch (error) {
    console.error('getMyStatus error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get personal attendance history (Renamed to fulfill getMyHistory requests)
 */
export const getMyHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const userId = req.user._id;
    console.log('=== getMyHistory ===');
    console.log('User:', req.user.firstName, req.user.lastName);
    console.log('userId:', userId);

    const history = await Attendance.find({ inspector: userId })
      .populate('shift', 'name displayName startTime endTime')
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Attendance.countDocuments({ inspector: userId });

    console.log('Found history records:', total);

    res.json({
      success: true,
      data: {
        history,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get monthly attendance summary and day-by-day working hours log for user
 */
export const getMyMonthlySummary = async (req, res) => {
  try {
    const isElevated = ['admin', 'superadmin'].includes(req.user.role);
    const targetUserId = (req.query.inspectorId && isElevated)
      ? req.query.inspectorId
      : req.user._id;

    const now = getISTNow();
    const month = parseInt(req.query.month) || (now.getMonth() + 1); // 1-indexed (1 to 12)
    const year = parseInt(req.query.year) || now.getFullYear();

    // Start and end of month in IST
    const startOfMonth = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const userObjId = mongoose.Types.ObjectId.isValid(targetUserId)
      ? new mongoose.Types.ObjectId(String(targetUserId))
      : null;

    const inspectorCondition = userObjId
      ? { $in: [targetUserId, String(targetUserId), userObjId] }
      : targetUserId;

    // Fetch records for the selected month
    const records = await Attendance.find({
      inspector: inspectorCondition,
      $or: [
        { date: { $gte: startOfMonth, $lte: endOfMonth } },
        { checkInTime: { $gte: startOfMonth, $lte: endOfMonth } }
      ]
    })
      .populate('shift', 'name displayName startTime endTime')
      .sort({ date: -1 })
      .lean();

    let totalWorkingHours = 0;
    let presentDays = 0;
    let halfDays = 0;
    let lateDays = 0;
    let earlyCheckoutDays = 0;

    const formattedRecords = records.map(r => {
      let hours = r.workingHours || 0;
      // If currently checked in and hasn't checked out today, compute live working hours
      if (r.checkInTime && !r.checkOutTime) {
        const checkInDate = new Date(r.checkInTime);
        const liveHours = Math.max(0, (Date.now() - checkInDate.getTime()) / (1000 * 60 * 60));
        hours = parseFloat(liveHours.toFixed(2));
      } else if (typeof hours === 'number') {
        hours = parseFloat(hours.toFixed(2));
      }

      totalWorkingHours += hours;

      if (r.status === 'present' || r.checkInTime) {
        presentDays++;
      }
      if (r.isHalfDay || r.status === 'half-day') {
        halfDays++;
      }
      if (r.isLate) {
        lateDays++;
      }
      if (r.isEarlyCheckout) {
        earlyCheckoutDays++;
      }

      return {
        ...r,
        workingHours: hours
      };
    });

    totalWorkingHours = parseFloat(totalWorkingHours.toFixed(2));
    const avgDailyHours = presentDays > 0 ? parseFloat((totalWorkingHours / presentDays).toFixed(2)) : 0;
    const daysInMonth = new Date(year, month, 0).getDate();
    const isCurrentMonth = (year === now.getFullYear() && month === (now.getMonth() + 1));
    const currentDay = isCurrentMonth ? now.getDate() : daysInMonth;
    
    // Count weekdays (excluding Sundays) as working days up to currentDay
    let workingDaysSoFar = 0;
    let totalWorkingDaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = new Date(year, month - 1, d).getDay();
      if (dayOfWeek !== 0) { // Exclude Sundays
        totalWorkingDaysInMonth++;
        if (d <= currentDay) {
          workingDaysSoFar++;
        }
      }
    }

    const attendanceRate = workingDaysSoFar > 0
      ? Math.min(100, Math.round((presentDays / workingDaysSoFar) * 100))
      : (currentDay > 0 ? Math.min(100, Math.round((presentDays / currentDay) * 100)) : 0);

    const targetMonthlyHours = totalWorkingDaysInMonth * 8; // 8 hours per working day
    const expectedHoursSoFar = workingDaysSoFar * 8;

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    res.json({
      success: true,
      data: {
        month,
        year,
        monthName: monthNames[month - 1] || 'Current Month',
        totalWorkingHours,
        targetMonthlyHours,
        expectedHoursSoFar,
        presentDays,
        halfDays,
        lateDays,
        earlyCheckoutDays,
        avgDailyHours,
        daysInMonth,
        currentDay,
        workingDaysSoFar,
        totalWorkingDaysInMonth,
        attendanceRate,
        records: formattedRecords
      }
    });
  } catch (error) {
    console.error('getMyMonthlySummary error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Legacy Compatibility: getMyAttendance (requested by attendanceRoutes.js)
 */
export const getMyAttendance = getMyHistory;

/**
 * Legacy Compatibility: Export attendance report (requested by attendanceRoutes.js)
 */
export const exportAttendance = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenantId = req.user.tenantId;

    // Parse dates in local timezone
    const parseLocalDate = (dateStr) => {
      const parts = dateStr.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    };

    const query = { tenantId };
    if (startDate && endDate) {
      const start = parseLocalDate(startDate);
      const end = parseLocalDate(endDate);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    const logs = await Attendance.find(query)
      .populate('inspector', 'firstName lastName email')
      .populate('shift', 'name displayName startTime endTime')
      .sort({ date: 1 });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(logs.map(att => ({
      Date: att.date.toISOString().split('T')[0],
      Inspector: `${att.inspector?.firstName || ''} ${att.inspector?.lastName || ''}`,
      Email: att.inspector?.email || 'N/A',
      Shift: att.shift?.displayName || 'N/A',
      CheckIn: att.checkInTime ? att.checkInTime.toLocaleTimeString() : 'N/A',
      CheckOut: att.checkOutTime ? att.checkOutTime.toLocaleTimeString() : 'N/A',
      WorkingHours: att.workingHours,
      Status: att.status,
      Late: att.isLate ? 'Yes' : 'No'
    })));

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_report.xlsx');
    res.send(buffer);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Legacy Compatibility: getAttendance (requested by attendanceRoutes.js)
 */
export const getAttendance = async (req, res) => {
  try {
    const { startDate, endDate, inspectorId, status } = req.query;
    const tenantId = req.user.tenantId;

    console.log('getAttendance - startDate:', startDate, 'endDate:', endDate, 'tenantId:', tenantId);

    // Parse dates in local timezone (matching how Attendance.date is stored)
    const parseLocalDate = (dateStr) => {
      const parts = dateStr.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    };

    const now = new Date();
    const start = startDate ? parseLocalDate(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate ? parseLocalDate(endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    const query = { tenantId, date: { $gte: start, $lte: end } };
    if (inspectorId) query.inspector = inspectorId;
    if (status) query.status = status;

    console.log('getAttendance - date range:', start.toISOString(), 'to', end.toISOString());
    console.log('getAttendance - full query:', JSON.stringify(query));

    const logs = await Attendance.find(query)
      .populate('inspector', 'firstName lastName username email')
      .populate('shift', 'name displayName')
      .sort({ date: -1 });

    console.log('getAttendance - found logs:', logs.length);
    if (logs.length > 0) {
      console.log('getAttendance - first log date:', logs[0].date);
      console.log('getAttendance - first log inspector:', logs[0].inspector);
    }

    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Legacy Compatibility: getAttendanceSummary (requested by attendanceRoutes.js)
 */
export const getAttendanceSummary = async (req, res) => {
  try {
    const today = getISTToday();
    const tenantId = req.user.tenantId;
    const query = { tenantId, date: { $gte: today } };

    const [totalUsers, present, late, halfDay] = await Promise.all([
      Attendance.countDocuments({ tenantId, date: { $gte: today } }),
      Attendance.countDocuments({ ...query, status: 'present' }),
      Attendance.countDocuments({ ...query, status: 'late' }),
      Attendance.countDocuments({ ...query, status: 'half-day' })
    ]);

    res.json({
      success: true,
      data: { totalUsers, present, late, halfDay, absent: Math.max(0, totalUsers - present - late - halfDay) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Legacy Compatibility: getAttendanceUsers (requested by attendanceRoutes.js)
 */
export const getAttendanceUsers = async (req, res) => {
  try {
    const logs = await Attendance.find({ tenantId: req.user.tenantId })
      .populate('inspector', 'firstName lastName email')
      .sort({ date: -1 });
    res.json({ success: true, users: logs }); // Old logic returned logs here
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Heartbeat (requested by attendanceRoutes.js)
 */
export const updateLastActive = async (req, res) => {
  try {
    const today = getISTToday();
    const attendance = await Attendance.findOne({
      inspector: req.user._id,
      date: { $gte: today },
      checkOutTime: null
    });

    if (attendance) {
      await attendance.save(); // Just trigger timestamps update or implement lastActive field
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Login Location (requested by attendanceRoutes.js)
 */
export const updateLoginLocation = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const today = getISTToday();
    const attendance = await Attendance.findOne({
      inspector: req.user._id,
      date: { $gte: today },
      checkOutTime: null
    });

    if (attendance) {
      attendance.checkInLat = lat;
      attendance.checkInLng = lng;
      attendance.checkInAccuracy = accuracy;
      await attendance.save();
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Send OTP for attendance verification
 */
export const sendAttendanceOTP = async (req, res) => {
  try {
    const user = req.user;
    const mobile = user.mobile;

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'No mobile number registered' });
    }

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Save OTP to user
    user.attendanceOTP = otp;
    await user.save();

    // Send OTP via SMS
    const result = await smsService.sendOTP(mobile, otp);

    if (!result.success) {
      return res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }

    res.json({ success: true, message: 'OTP sent to your mobile number' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Create attendance record (Admin/HR)
 */
export const createAttendance = async (req, res) => {
  try {
    const { userId, date, status, checkIn, checkOut, workingHours } = req.body;
    const tenantId = req.user.tenantId;

    console.log('createAttendance - received:', { userId, date, status, checkIn, checkOut, workingHours });

    // Validate required fields
    if (!userId || !date || !status) {
      return res.status(400).json({ success: false, message: 'Missing required fields: userId, date, status' });
    }

    // Resolve user - handle both ObjectId and name string
    let resolvedUserId = userId;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      resolvedUserId = userId;
    } else {
      // Try to find user by name or username
      const nameParts = userId.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const userByName = await User.findOne({
        tenantId,
        $or: [
          { firstName, lastName },
          { username: userId }  // Also try username lookup
        ]
      }).select('_id');

      if (!userByName) {
        return res.status(404).json({ success: false, message: `User "${userId}" not found in this tenant` });
      }
      resolvedUserId = userByName._id;
    }

    // Parse date
    const parseLocalDate = (dateStr) => {
      const parts = dateStr.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    };

    const attendanceDate = parseLocalDate(date);
    attendanceDate.setHours(0, 0, 0, 0);

    // Check if attendance already exists for this user and date
    let attendance = await Attendance.findOne({
      inspector: resolvedUserId,
      date: { $gte: attendanceDate, $lt: new Date(attendanceDate.getTime() + 24 * 60 * 60 * 1000) }
    });

    // Prepare attendance data
    const attendanceData = {
      inspector: resolvedUserId,
      tenantId,
      date: attendanceDate,
      status: status || 'present',
      isPresent: status === 'present' || status === 'late' || status === 'half-day'
    };

    // Handle shift type with check-in/check-out times
    if ((status === 'shift' || status === 'present' || status === 'half-day') && checkIn && checkOut) {
      // Parse ISO datetime strings (e.g., "2026-06-03T09:03")
      const checkInTime = new Date(checkIn);
      const checkOutTime = new Date(checkOut);

      if (!isNaN(checkInTime.getTime()) && !isNaN(checkOutTime.getTime())) {
        attendanceData.checkInTime = checkInTime;
        attendanceData.checkOutTime = checkOutTime;

        // Calculate working hours
        const workingHoursMs = checkOutTime - checkInTime;
        attendanceData.workingHours = Math.round((workingHoursMs / (1000 * 60 * 60)) * 100) / 100;

        // Handle provided shift name or auto-detect
        if (req.body.shift) {
          // Use shift name from frontend
          attendanceData.shiftName = req.body.shift;
        } else {
          // Auto-detect shift based on check-in time
          const allShifts = await Shift.find({ tenantId, isActive: true });
          const currentMins = checkInTime.getHours() * 60 + checkInTime.getMinutes();

          const toMins = (t) => {
            if (!t) return null;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m;
          };

          const shift = allShifts.find(s => {
            const startMins = toMins(s.startTime);
            const shiftEndMins = toMins(s.endTime);
            const isNight = s.isNightShift || startMins > shiftEndMins;
            const bufferedStart = (startMins - 15 + 1440) % 1440;

            if (isNight) {
              return currentMins >= bufferedStart || currentMins < shiftEndMins;
            }
            return currentMins >= bufferedStart && currentMins < shiftEndMins;
          });

          if (shift) {
            attendanceData.shift = shift._id;
            attendanceData.shiftName = shift.displayName || shift.name;
            attendanceData.shiftStartTime = shift.startTime;
            attendanceData.shiftEndTime = shift.endTime;
          } else {
            // Default shift name when no shift found
            attendanceData.shiftName = 'General';
          }
        }
      }
    }

    if (attendance) {
      // Update existing attendance
      Object.assign(attendance, attendanceData);
      await attendance.save();
      console.log('createAttendance - updated:', attendance);
    } else {
      // Create new attendance
      attendance = await Attendance.create(attendanceData);
      console.log('createAttendance - created:', attendance);
    }

    // Populate and return
    const populated = await Attendance.findById(attendance._id)
      .populate('inspector', 'firstName lastName email username')
      .populate('shift', 'name displayName startTime endTime');

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('createAttendance error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Fetch all inspectors, admins, and subadmins in current tenant
 */
export const getInspectors = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const users = await User.find({
      tenantId,
      isActive: true,
      role: { $in: ['inspector', 'admin', 'subadmin', 'superadmin'] }
    }).select('firstName lastName username email role').lean();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Swap inspector responses and log in SwapLog
 */
/**
 * Swap responses between two inspectors
 * POST /api/attendance/swap-responses
 */
export const swapResponses = async (req, res) => {
  try {
    const {
      sourceUserId,
      targetUserId,
      sourceDate,
      targetDate,
      formId,
      quantities
    } = req.body;

    console.log('🔄 [SWAP] Request received:', {
      sourceUserId,
      targetUserId,
      sourceDate,
      targetDate,
      formId,
      quantities
    });

    // ─── 1. VALIDATE INPUTS ──────────────────────────────────────────
    if (!sourceUserId || !targetUserId || !sourceDate || !targetDate || !formId || !quantities) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Check if users exist
    const [sourceUser, targetUser] = await Promise.all([
      User.findById(sourceUserId),
      User.findById(targetUserId)
    ]);

    if (!sourceUser) {
      return res.status(404).json({ success: false, message: 'Source user not found' });
    }
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target user not found' });
    }

    // ─── 2. BUILD DATE RANGES ──────────────────────────────────────────
    const sourceStartDate = new Date(sourceDate);
    sourceStartDate.setHours(0, 0, 0, 0);
    const sourceEndDate = new Date(sourceDate);
    sourceEndDate.setHours(23, 59, 59, 999);

    const targetStartDate = new Date(targetDate);
    targetStartDate.setHours(0, 0, 0, 0);
    const targetEndDate = new Date(targetDate);
    targetEndDate.setHours(23, 59, 59, 999);

    // ─── 3. GET FORM ──────────────────────────────────────────────────
    const form = await Form.findOne({ id: formId }).lean();
    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    // ─── 4. GET SOURCE USER'S RESPONSES ──────────────────────────────
    const sourceQuery = {
      questionId: formId,
      createdBy: sourceUserId,
      createdAt: { $gte: sourceStartDate, $lte: sourceEndDate },
      isSectionSubmit: { $ne: true }
    };

    const sourceResponses = await Response.find(sourceQuery).lean();
    console.log(`🔄 [SWAP] Found ${sourceResponses.length} responses for source user on ${sourceDate}`);

    if (sourceResponses.length === 0) {
      return res.status(400).json({
        success: false,
        message: `No responses found for source user on ${sourceDate}`
      });
    }

    // ─── 5. CATEGORIZE RESPONSES BY STATUS ────────────────────────────
    const getResponseStatus = (answers) => {
      const answersObj = answers instanceof Map ? Object.fromEntries(answers) : answers;
      const formChassisMap = {};
      // ✅ First, check if there's a chassis answer with status
      const chassisId = formChassisMap[formId]; // You need to pass this
      if (chassisId && answersObj[chassisId]) {
        const chassisAnswer = answersObj[chassisId];
        if (typeof chassisAnswer === 'object' && chassisAnswer.status) {
          const s = String(chassisAnswer.status).toLowerCase().trim();
          if (s === 'rejected') return 'Rejected';
          if (s === 'rework' || s === 'rework pending') return 'Rework QC Pending';
          if (s === 'rework completed' || s === 'rework accepted') return 'Rework QC Completed';
          if (s === 'accepted' || s === 'direct ok' || s === 'verified') return 'Direct Ok';
        }
        if (typeof chassisAnswer === 'string') {
          const s = chassisAnswer.toLowerCase().trim();
          if (s === 'rejected') return 'Rejected';
          if (s === 'rework' || s === 'rework pending') return 'Rework QC Pending';
          if (s === 'rework completed' || s === 'rework accepted') return 'Rework QC Completed';
          if (s === 'accepted' || s === 'direct ok' || s === 'verified') return 'Direct Ok';
        }
      }
      // Extract all values
      const extractAllValues = (obj, depth = 0) => {
        const values = [];
        if (depth > 5) return values;
        if (obj === null || obj === undefined) return values;
        if (typeof obj === 'string') {
          if (obj.trim()) values.push(obj.trim());
        } else if (Array.isArray(obj)) {
          obj.forEach(item => values.push(...extractAllValues(item, depth + 1)));
        } else if (typeof obj === 'object') {
          const statusFields = ['status', 'reviewOption', 'review', 'option', 'value', 'text', 'label', 'answer'];
          for (const field of statusFields) {
            if (obj[field] && typeof obj[field] === 'string') {
              values.push(obj[field]);
            }
          }
          Object.values(obj).forEach(val => {
            if (typeof val === 'string' || typeof val === 'object') {
              values.push(...extractAllValues(val, depth + 1));
            }
          });
        }
        return values;
      };

      const allValues = extractAllValues(answersObj);

      // ✅ Priority 1: Rejected
      for (const value of allValues) {
        if (!value) continue;
        const str = String(value).toLowerCase().trim();
        if (!str) continue;
        if (str === 'rejected' || str === 'reject' || str === 'no' || str === 'nok' || str === 'fail' || str === 'failed') {
          return 'Rejected';
        }
      }

      // ✅ Priority 2: Rework QC Pending
      for (const value of allValues) {
        if (!value) continue;
        const str = String(value).toLowerCase().trim();
        if (!str) continue;
        if (str === 'rework' || str === 'rework pending' || str.includes('rework')) {
          return 'Rework QC Pending';
        }
      }

      // ✅ Priority 3: Rework QC Completed
      for (const value of allValues) {
        if (!value) continue;
        const str = String(value).toLowerCase().trim();
        if (!str) continue;
        if (str === 'rework completed' || str === 'rework accepted' || str === 'rework complete' || str === 'done') {
          return 'Rework QC Completed';
        }
      }

      // ✅ Priority 4: Direct Ok
      for (const value of allValues) {
        if (!value) continue;
        const str = String(value).toLowerCase().trim();
        if (!str) continue;
        if (str === 'accepted' || str === 'direct ok' || str === 'directok' || str === 'yes' || str === 'verified' || str === 'ok') {
          return 'Direct Ok';
        }
      }

      return 'Unknown';
    };

    const categorizedResponses = {
      'Direct Ok': [],
      'Rework QC Completed': [],
      'Rework QC Pending': [],
      'Rejected': []
    };

    sourceResponses.forEach(response => {
      const status = getResponseStatus(response.answers);
      if (categorizedResponses[status]) {
        categorizedResponses[status].push(response);
      }
    });

    console.log('🔄 [SWAP] Categorized source responses:', {
      'Direct Ok': categorizedResponses['Direct Ok'].length,
      'Rework QC Completed': categorizedResponses['Rework QC Completed'].length,
      'Rework QC Pending': categorizedResponses['Rework QC Pending'].length,
      'Rejected': categorizedResponses['Rejected'].length
    });

    // ─── 6. SELECT RESPONSES TO SWAP ──────────────────────────────────
    const responsesToSwap = [];
    const statusMap = {
      'Direct Ok': quantities.directOk || 0,
      'Rework QC Completed': quantities.reworkCompleted || 0,
      'Rework QC Pending': quantities.reworkPending || 0,
      'Rejected': quantities.rejected || 0
    };

    console.log('🔄 [SWAP] Requested quantities:', statusMap);

    for (const [status, count] of Object.entries(statusMap)) {
      if (count > 0 && categorizedResponses[status]) {
        const available = categorizedResponses[status];
        if (available.length < count) {
          return res.status(400).json({
            success: false,
            message: `Not enough ${status} responses. Available: ${available.length}, Requested: ${count}`
          });
        }
        const selected = available.slice(0, count);
        responsesToSwap.push(...selected);
        console.log(`🔄 [SWAP] Selected ${selected.length} ${status} responses`);
      }
    }

    if (responsesToSwap.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No responses selected for swap.'
      });
    }

    console.log(`🔄 [SWAP] Total responses to swap: ${responsesToSwap.length}`);
    const sourceResponseIds = responsesToSwap.map(r => r._id);

    // ─── 7. DELETE TARGET USER'S EXISTING RESPONSES ON TARGET DATE ──
    const deleteTargetQuery = {
      questionId: formId,
      createdBy: targetUserId,
      createdAt: { $gte: targetStartDate, $lte: targetEndDate },
      isSectionSubmit: { $ne: true }
    };

    const deletedTargetResult = await Response.deleteMany(deleteTargetQuery);
    console.log(`🔄 [SWAP] Deleted ${deletedTargetResult.deletedCount} existing responses from target user on ${targetDate}`);

    // ─── 8. CREATE NEW RESPONSES FOR TARGET USER ──────────────────────
    const newResponses = [];

    for (const sourceResponse of responsesToSwap) {
      const originalTime = sourceResponse.createdAt;
      const timeStr = originalTime.toTimeString().split(' ')[0];
      const newCreatedAt = new Date(`${targetDate}T${timeStr}`);

      const newResponseData = {
        ...sourceResponse,
        id: uuidv4(),
        createdBy: targetUserId,
        submittedBy: `${targetUser.firstName} ${targetUser.lastName}`,
        createdAt: newCreatedAt,
        updatedAt: new Date(),
        swappedFrom: sourceUserId,
        swappedAt: new Date(),
      };

      delete newResponseData._id;
      delete newResponseData.__v;

      const saved = await Response.create(newResponseData);
      newResponses.push(saved);
    }

    console.log(`🔄 [SWAP] Created ${newResponses.length} new responses for target user on ${targetDate}`);

    // ─── ✅ 9. DELETE SOURCE RESPONSES (THIS IS THE KEY FIX!) ──────
    const deleteSourceQuery = {
      _id: { $in: sourceResponseIds }
    };

    const deletedSourceResult = await Response.deleteMany(deleteSourceQuery);
    console.log(`🔄 [SWAP] Deleted ${deletedSourceResult.deletedCount} source responses`);

    // ─── 10. LOG THE SWAP ─────────────────────────────────────────────
    try {
      const SwapLog = mongoose.model('SwapLog');
      await SwapLog.create({
        sourceUser: sourceUserId,
        targetUser: targetUserId,
        sourceDate: sourceDate,
        targetDate: targetDate,
        formId: formId,
        swappedResponses: sourceResponseIds,
        newResponses: newResponses.map(r => r._id),
        quantities: {
          directOk: quantities.directOk || 0,
          reworkCompleted: quantities.reworkCompleted || 0,
          reworkPending: quantities.reworkPending || 0,
          rejected: quantities.rejected || 0
        },
        swappedBy: req.user._id,
        tenantId: req.user.tenantId
      });
      console.log('🔄 [SWAP] Swap logged successfully');
    } catch (logError) {
      console.warn('⚠️ [SWAP] Failed to log swap:', logError);
    }

    // ─── 11. RETURN RESPONSE ──────────────────────────────────────────
    res.json({
      success: true,
      message: `Successfully swapped ${responsesToSwap.length} responses from ${sourceUser.firstName} ${sourceUser.lastName} on ${sourceDate} to ${targetUser.firstName} ${targetUser.lastName} on ${targetDate}`,
      data: {
        swappedCount: responsesToSwap.length,
        statusBreakdown: statusMap,
        sourceUser: {
          id: sourceUserId,
          name: `${sourceUser.firstName} ${sourceUser.lastName}`
        },
        targetUser: {
          id: targetUserId,
          name: `${targetUser.firstName} ${targetUser.lastName}`
        }
      }
    });

  } catch (error) {
    console.error('❌ [SWAP] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to swap responses: ' + error.message
    });
  }
};
/**
 * Update attendance time (Admin only)
 * PUT /api/attendance/:id/time
 */
export const updateAttendanceTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { checkIn, checkOut, status, shift } = req.body;
    const tenantId = req.user.tenantId;

    console.log('🔧 [updateAttendanceTime] Request received:', { id, checkIn, checkOut, status, shift });

    // Find the attendance record
    const attendance = await Attendance.findOne({ _id: id, tenantId });

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found'
      });
    }

    console.log('🔧 [updateAttendanceTime] Found attendance:', {
      inspector: attendance.inspector,
      date: attendance.date,
      currentStatus: attendance.status
    });

    // Update check-in time
    if (checkIn !== undefined) {
      if (checkIn === null || checkIn === '') {
        attendance.checkInTime = null;
      } else {
        const parsedCheckIn = new Date(checkIn);
        if (!isNaN(parsedCheckIn.getTime())) {
          attendance.checkInTime = parsedCheckIn;
        }
      }
    }

    // Update check-out time
    if (checkOut !== undefined) {
      if (checkOut === null || checkOut === '') {
        attendance.checkOutTime = null;
      } else {
        const parsedCheckOut = new Date(checkOut);
        if (!isNaN(parsedCheckOut.getTime())) {
          attendance.checkOutTime = parsedCheckOut;
        }
      }
    }

    // Update status
    if (status) {
      attendance.status = status;
      attendance.isPresent = status === 'present' || status === 'late' || status === 'half-day';
    }

    // Update shift name
    if (shift !== undefined) {
      attendance.shiftName = shift || 'No shift';
    }

    // Recalculate working hours if both check-in and check-out exist
    if (attendance.checkInTime && attendance.checkOutTime) {
      const workingHoursMs = attendance.checkOutTime.getTime() - attendance.checkInTime.getTime();
      attendance.workingHours = parseFloat((workingHoursMs / (1000 * 60 * 60)).toFixed(2));
    } else if (attendance.checkInTime && !attendance.checkOutTime) {
      // If only check-in exists, calculate from check-in to now
      const now = new Date();
      const workingHoursMs = now.getTime() - attendance.checkInTime.getTime();
      attendance.workingHours = parseFloat((workingHoursMs / (1000 * 60 * 60)).toFixed(2));
    } else {
      attendance.workingHours = 0;
    }

    await attendance.save();

    console.log('🔧 [updateAttendanceTime] Updated attendance:', {
      id: attendance._id,
      status: attendance.status,
      checkIn: attendance.checkInTime,
      checkOut: attendance.checkOutTime,
      workingHours: attendance.workingHours
    });

    // Populate and return
    const populated = await Attendance.findById(attendance._id)
      .populate('inspector', 'firstName lastName email username')
      .populate('shift', 'name displayName startTime endTime');

    res.json({
      success: true,
      message: 'Attendance updated successfully',
      data: populated
    });

  } catch (error) {
    console.error('❌ [updateAttendanceTime] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update attendance: ' + error.message
    });
  }
};
