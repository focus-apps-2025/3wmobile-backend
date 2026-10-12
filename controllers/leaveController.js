import Leave from '../models/Leave.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';

/**
 * Apply for leave
 */
export const applyLeave = async (req, res) => {
  try {
    const { leaveType, startDate, endDate, reason } = req.body;
    const inspectorId = req.user._id;
    const tenantId = req.user.tenantId;

    console.log('applyLeave - received:', { leaveType, startDate, endDate, reason, inspectorId, tenantId });

    const leave = await Leave.create({
      inspector: inspectorId,
      tenantId,
      leaveType,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      reason
    });

    console.log('applyLeave - created:', leave);

    // Notify Admins and Subadmins of this tenant
    const admins = await User.find({
      tenantId,
      role: { $in: ['admin', 'subadmin'] },
      isActive: true
    });

    const notificationData = admins.map(admin => ({
      user: admin._id,
      tenantId,
      title: 'New Leave Request',
      message: `${req.user.firstName} ${req.user.lastName} has applied for ${leaveType} leave.`,
      type: 'leave_request',
      relatedEntity: 'leave',
      entityId: leave._id
    }));

    console.log('applyLeave - creating notifications for:', admins.map(a => a.firstName));
    console.log('applyLeave - notificationData:', notificationData);

    if (notificationData.length > 0) {
      const result = await Notification.insertMany(notificationData);
      console.log('applyLeave - created notifications:', result.length);
    }

    res.status(201).json({ success: true, data: leave });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get personal leave history
 */
export const getMyLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find({ inspector: req.user._id })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all leaves (Admin)
 */
export const getAllLeaves = async (req, res) => {
  try {
    const { status } = req.query;
    const query = { tenantId: req.user.tenantId };
    if (status) query.status = status;

    const leaves = await Leave.find(query)
      .populate('inspector', 'firstName lastName email')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Update leave status (Approve/Reject)
 */
export const updateLeaveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, comments } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const leave = await Leave.findById(id);
    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave not found' });
    }

    leave.status = status;
    leave.comments = comments;
    leave.actionedBy = req.user._id;
    leave.actionedAt = new Date();
    await leave.save();

    // Notify the inspector
    await Notification.create({
      user: leave.inspector,
      tenantId: req.user.tenantId,
      title: `Leave ${status.toUpperCase()}`,
      message: `Your leave request from ${leave.startDate.toDateString()} has been ${status}.`,
      type: 'leave_status',
      relatedEntity: 'leave',
      entityId: leave._id
    });

    res.json({ success: true, data: leave });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
