import cron from 'node-cron';
import HRPermission from '../models/HRPermission.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';

export const startPermissionCron = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Look for permissions that expired in the last 1-2 minutes
      // This ensures we catch permissions exactly once when the 16th minute hits
      const oneMinuteAgo = new Date(now.getTime() - 60000);
      const twoMinutesAgo = new Date(now.getTime() - 120000);

      const expiredPermissions = await HRPermission.find({
        status: 'approved',
        endTime: { $lte: oneMinuteAgo, $gt: twoMinutesAgo }
      }).populate('inspector');

      if (!expiredPermissions || expiredPermissions.length === 0) {
        return;
      }

      for (const permission of expiredPermissions) {
        const inspector = permission.inspector;
        if (!inspector) continue;

        const tenantId = permission.tenantId;

        // Find admins to notify
        const admins = await User.find({
          tenantId,
          role: { $in: ['admin', 'subadmin'] },
          isActive: true
        });

        const notifications = [];

        // Notify the user themselves
        notifications.push({
          user: inspector._id,
          tenantId,
          title: 'Permission Time Exceeded',
          message: `Your approved permission (${permission.permissionType}) has exceeded the allotted time. Please report back immediately.`,
          type: 'alert',
          relatedEntity: 'permission',
          entityId: permission._id
        });

        // Notify admins
        admins.forEach(admin => {
          notifications.push({
            user: admin._id,
            tenantId,
            title: 'Inspector Permission Exceeded',
            message: `${inspector.firstName} ${inspector.lastName}'s permission (${permission.permissionType}) has exceeded the allotted time.`,
            type: 'alert',
            relatedEntity: 'permission',
            entityId: permission._id
          });
        });

        if (notifications.length > 0) {
          await Notification.insertMany(notifications);
        }
        
        console.log(`[Cron] Sent permission expiry notifications for ${inspector.firstName} ${inspector.lastName}`);
      }
    } catch (error) {
      console.error('[Cron] Error checking expired permissions:', error);
    }
  });
};
