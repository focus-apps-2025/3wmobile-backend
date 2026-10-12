import Shift from '../models/Shift.js';
import Attendance from '../models/Attendance.js';
import User from '../models/User.js';

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Helper to convert HH:mm to minutes from midnight
 */
const toMins = (t) => {
  if (!t || !timeRegex.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Helper to check if two shifts overlap
 */
const shiftsOverlap = (s1, s2) => {
  const start1 = toMins(s1.startTime);
  const end1 = toMins(s1.endTime);
  const isNight1 = s1.isNightShift || start1 > end1;

  const start2 = toMins(s2.startTime);
  const end2 = toMins(s2.endTime);
  const isNight2 = s2.isNightShift || start2 > end2;

  // Get ranges as sets of [start, end]
  const getRanges = (start, end, isNight) => {
    if (isNight) {
      return [[start, 1440], [0, end]];
    }
    return [[start, end]];
  };

  const ranges1 = getRanges(start1, end1, isNight1);
  const ranges2 = getRanges(start2, end2, isNight2);

  for (const [r1s, r1e] of ranges1) {
    for (const [r2s, r2e] of ranges2) {
      // Strict non-overlap: max(start) < min(end)
      // This allows touching boundaries (e.g. 17:00 and 17:00)
      if (Math.max(r1s, r2s) < Math.min(r1e, r2e)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Create a new shift
 */
export const createShift = async (req, res) => {
  try {
    const { name, displayName, startTime, endTime, gracePeriod, lateMarkingAfter, halfDayMarkingAfter, assignedInspectors, isNightShift } = req.body;
    const tenantId = req.user.tenantId;

    // Input validation
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:mm' });
    }
    if (startTime === endTime) {
      return res.status(400).json({ success: false, message: 'Start time and end time cannot be same' });
    }

    // Validate duplicate name
    const existingShiftName = await Shift.findOne({ tenantId, name, isActive: true });
    if (existingShiftName) {
      return res.status(400).json({ success: false, message: 'Shift name already exists' });
    }

    // Validate overlaps
    const allActiveShifts = await Shift.find({ tenantId, isActive: true });
    const newShiftData = { startTime, endTime, isNightShift: isNightShift || toMins(startTime) > toMins(endTime) };
    for (const s of allActiveShifts) {
      if (shiftsOverlap(newShiftData, s)) {
        return res.status(400).json({ 
          success: false, 
          message: `Shift overlaps with existing shift: ${s.name} (${s.startTime}-${s.endTime})` 
        });
      }
    }

    const shift = await Shift.create({
      name,
      displayName,
      startTime,
      endTime,
      gracePeriod,
      lateMarkingAfter,
      halfDayMarkingAfter,
      assignedInspectors: assignedInspectors || [],
      isNightShift: isNightShift || false,
      tenantId,
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, data: shift });
  } catch (error) {
    console.error('Create shift error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all shifts for a tenant
 */
export const getShifts = async (req, res) => {
  try {
    const shifts = await Shift.find({ tenantId: req.user.tenantId, isActive: true })
      .populate('assignedInspectors', 'firstName lastName username email');
    res.json({ success: true, data: shifts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Update a shift
 */
export const updateShift = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const tenantId = req.user.tenantId;

    const shift = await Shift.findOne({ _id: id, tenantId });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    // Input validation
    if ((updateData.startTime && !timeRegex.test(updateData.startTime)) || 
        (updateData.endTime && !timeRegex.test(updateData.endTime))) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:mm' });
    }

    const nextStartTime = updateData.startTime || shift.startTime;
    const nextEndTime = updateData.endTime || shift.endTime;

    if (nextStartTime === nextEndTime) {
      return res.status(400).json({ success: false, message: 'Start time and end time cannot be same' });
    }

    // Validate overlaps if timing or isNightShift changed
    const timingChanged = 
      (updateData.startTime && updateData.startTime !== shift.startTime) || 
      (updateData.endTime && updateData.endTime !== shift.endTime) ||
      (updateData.isNightShift !== undefined && updateData.isNightShift !== shift.isNightShift);

    if (timingChanged) {
      const allActiveShifts = await Shift.find({ 
        tenantId, 
        isActive: true, 
        _id: { $ne: id } 
      });
      const updatedShiftData = {
        startTime: nextStartTime,
        endTime: nextEndTime,
        isNightShift: updateData.isNightShift !== undefined ? updateData.isNightShift : shift.isNightShift
      };

      for (const s of allActiveShifts) {
        if (shiftsOverlap(updatedShiftData, s)) {
          return res.status(400).json({ 
            success: false, 
            message: `Updated timing overlaps with existing shift: ${s.name} (${s.startTime}-${s.endTime})` 
          });
        }
      }
    }

    Object.assign(shift, updateData);
    await shift.save();

    // If timing changed, the plan says reset all attendance records for this shift
    if (timingChanged) {
      // NOTE: This is a destructive operation as per plan Phase 2.2
      await Attendance.updateMany(
        { shift: id, tenantId },
        { 
          status: 'absent',
          checkInTime: null,
          checkOutTime: null,
          workingHours: 0,
          isLate: false,
          isHalfDay: false
        }
      );
    }

    res.json({ success: true, data: shift });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Delete a shift (Soft delete)
 */
export const deleteShift = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const shift = await Shift.findOne({ _id: id, tenantId });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    // Soft delete the shift
    shift.isActive = false;
    shift.assignedInspectors = []; // Free up inspectors
    shift.name = `${shift.name}_deleted_${Date.now()}`; // Prevent E11000 duplicate key errors if a shift with the same name is created again
    await shift.save();

    res.json({ success: true, message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Assign inspectors to shift
 */
export const assignInspectors = async (req, res) => {
  try {
    const { id } = req.params;
    const { inspectorIds } = req.body; // Array of user IDs
    const tenantId = req.user.tenantId;

    const shift = await Shift.findOne({ _id: id, tenantId });
    if (!shift) return res.status(404).json({ success: false, message: 'Shift not found' });

    // Validate inspectors exist and belong to tenant
    const users = await User.find({ _id: { $in: inspectorIds }, tenantId, role: 'inspector' });
    if (users.length !== inspectorIds.length) {
      return res.status(400).json({ success: false, message: 'Invalid inspectors selected' });
    }

    // Remove these inspectors from ALL other shifts for this tenant
    await Shift.updateMany(
      { tenantId, _id: { $ne: id } },
      { $pull: { assignedInspectors: { $in: inspectorIds } } }
    );

    // Merge without duplicates
    const currentAssignments = shift.assignedInspectors.map(id => id.toString());
    const newAssignments = [...new Set([...currentAssignments, ...inspectorIds])];
    
    shift.assignedInspectors = newAssignments;
    await shift.save();

    res.json({ success: true, data: shift });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Remove inspectors from shift
 */
export const removeInspectors = async (req, res) => {
  try {
    const { id } = req.params;
    const { inspectorIds } = req.body;
    const tenantId = req.user.tenantId;

    const shift = await Shift.findOne({ _id: id, tenantId });
    if (!shift) return res.status(404).json({ success: false, message: 'Shift not found' });

    shift.assignedInspectors = shift.assignedInspectors.filter(
      insId => !inspectorIds.includes(insId.toString())
    );
    
    await shift.save();
    res.json({ success: true, data: shift });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get available (unassigned) inspectors for the tenant
 */
export const getAvailableInspectors = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    
    // Get all assigned inspector IDs from ALL shifts in this tenant
    const shifts = await Shift.find({ tenantId, isActive: true });
    const assignedIds = shifts.reduce((acc, s) => {
      return acc.concat(s.assignedInspectors.map(id => id.toString()));
    }, []);

    const unassignedInspectors = await User.find({
      tenantId,
      role: 'inspector',
      isActive: true,
      _id: { $nin: assignedIds }
    }).select('firstName lastName username email');

    res.json({ success: true, data: unassignedInspectors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get inspector's assigned shift
 */
export const getMyShift = async (req, res) => {
  try {
    const shift = await Shift.findOne({
      tenantId: req.user.tenantId,
      assignedInspectors: req.user._id,
      isActive: true
    });

    res.json({ success: true, data: shift });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
