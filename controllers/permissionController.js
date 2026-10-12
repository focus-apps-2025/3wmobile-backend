import HRPermission from '../models/HRPermission.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';

/**
 * Apply for permission (short leave, half day, etc)
 */
export const applyPermission = async (req, res) => {
  try {
    const { permissionType, date, startTime, endTime, duration, reason } = req.body;
    const inspectorId = req.user._id;
    const tenantId = req.user.tenantId;

    const permission = await HRPermission.create({
      inspector: inspectorId,
      tenantId,
      date: new Date(date),
      permissionType,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      duration,
      reason
    });

    // Notify Admins and Subadmins
    const admins = await User.find({
      tenantId,
      role: { $in: ['admin', 'subadmin'] },
      isActive: true
    });

    const notificationData = admins.map(admin => ({
      user: admin._id,
      tenantId,
      title: 'New Permission Request',
      message: `${req.user.firstName} ${req.user.lastName} has requested ${permissionType} permission.`,
      type: 'permission_request',
      relatedEntity: 'permission',
      entityId: permission._id
    }));

    if (notificationData.length > 0) {
      await Notification.insertMany(notificationData);
    }

    res.status(201).json({ success: true, data: permission });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get personal permission history
 */
export const getMyPermissions = async (req, res) => {
  try {
    const permissions = await HRPermission.find({ inspector: req.user._id })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: permissions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all permissions (Admin)
 */
export const getAllPermissions = async (req, res) => {
  try {
    const { status } = req.query;
    const query = { tenantId: req.user.tenantId };
    if (status) query.status = status;

    const permissions = await HRPermission.find(query)
      .populate('inspector', 'firstName lastName email')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: permissions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Update permission status
 */
export const updatePermissionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const permission = await HRPermission.findById(id);
    if (!permission) {
      return res.status(404).json({ success: false, message: 'Permission record not found' });
    }

    permission.status = status;
    permission.actionedBy = req.user._id;
    permission.actionedAt = new Date();
    await permission.save();

    // Notify inspector
    await Notification.create({
      user: permission.inspector,
      tenantId: req.user.tenantId,
      title: `Permission Request ${status.toUpperCase()}`,
      message: `Your ${permission.permissionType} request for ${permission.date.toDateString()} has been ${status}.`,
      type: 'permission_status',
      relatedEntity: 'permission',
      entityId: permission._id
    });

    res.json({ success: true, data: permission });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
