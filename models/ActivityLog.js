// models/ActivityLog.js
import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true
  },
  userRole: {
    type: String,
    enum: ['superadmin', 'admin', 'subadmin', 'teacher', 'student', 'staff', 'editor', 'viewer', 'inspector'],
    required: true
  },
  action: {
    type: String,
    enum: [
      // Auth actions
      'LOGIN', 'LOGOUT',
      
      // Form actions
      'CREATE_FORM', 'UPDATE_FORM', 'DELETE_FORM', 'VIEW_FORM', 'DUPLICATE_FORM',
      'PUBLISH_FORM', 'UNPUBLISH_FORM', 'ACTIVATE_FORM', 'DEACTIVATE_FORM',
      'VIEW_FORM_LIST', 'EXPORT_FORM', 'IMPORT_FORM',
      
      // Response actions
      'SUBMIT_RESPONSE', 'VERIFY_RESPONSE', 'REJECT_RESPONSE', 'ASSIGN_RESPONSE',
      'VIEW_RESPONSE', 'BATCH_IMPORT_RESPONSES', 'EXPORT_RESPONSES',
      'DELETE_RESPONSE', 'DELETE_MULTIPLE_RESPONSES',
      
      // Invite actions
      'SEND_INVITES', 'SEND_SMS_INVITES', 'VIEW_INVITES', 'UPLOAD_INVITES',
      
      // User actions
      'CREATE_USER', 'UPDATE_USER', 'DELETE_USER', 'RESET_PASSWORD', 'VIEW_USERS',
      'ASSIGN_ROLE', 'UPDATE_PROFILE', 'UPDATE_SETTINGS',
      
      // Admin actions
      'ASSIGN_RESPONSE_TO_SELF', 'AUTO_ASSIGN_RESPONSE',
      
      // Analytics actions
      'VIEW_DASHBOARD', 'VIEW_ANALYTICS', 'EXPORT_ANALYTICS',
      
      // Tenant actions
      'CREATE_TENANT', 'UPDATE_TENANT', 'DELETE_TENANT', 'TOGGLE_TENANT_STATUS',
      'ADD_ADMIN_TO_TENANT', 'REMOVE_ADMIN_FROM_TENANT',
      
      // File actions
      'UPLOAD_FILE', 'DELETE_FILE',
      
      // Page views and continuous activity
      'PAGE_VIEW', 'HEARTBEAT', 'FOCUS', 'BLUR'
    ],
    required: true,
    index: true
  },
  resourceId: {
    type: String, // formId, responseId, userId, etc.
    index: true
  },
  resourceType: {
    type: String,
    enum: ['form', 'response', 'user', 'invite', 'tenant', 'file', 'role', 'profile'],
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  ipAddress: String,
  userAgent: String,
  sessionId: String,
  duration: Number, // Time spent in seconds (for page views)
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '90d' // Auto-delete after 90 days
  }
});

// Compound indexes for efficient queries
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ resourceId: 1, resourceType: 1 });

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

export default ActivityLog;