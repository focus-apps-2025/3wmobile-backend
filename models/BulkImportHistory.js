import mongoose from 'mongoose';

const bulkImportHistorySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    index: true,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  userName: {
    type: String,
    default: 'System User'
  },
  userEmail: {
    type: String,
    default: ''
  },
  userRole: {
    type: String,
    default: 'admin'
  },
  actionType: {
    type: String,
    enum: [
      'BULK_RESPONSE_IMPORT',
      'FORM_EXCEL_IMPORT',
      'FORM_UPDATE',
      'BULK_REVIEW_UPDATE',
      'RESPONSE_DISPATCH'
    ],
    default: 'BULK_RESPONSE_IMPORT',
    index: true
  },
  actionTitle: {
    type: String,
    default: 'Bulk Response Import'
  },
  formId: {
    type: String,
    index: true
  },
  formTitle: {
    type: String,
    default: 'Untitled Form'
  },
  batchId: {
    type: String,
    index: true
  },
  fileName: {
    type: String,
    default: ''
  },
  templateType: {
    type: String,
    default: 'Main Form' // 'Main Form' | 'Template 2' | 'Follow-up'
  },
  dataCount: {
    total: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
  },
  details: {
    chassisNumbers: [{ type: String }],
    submitters: [{ type: String }],
    questionsCount: { type: Number, default: 0 },
    sampleRecords: [{ type: mongoose.Schema.Types.Mixed }],
    errors: [{ type: mongoose.Schema.Types.Mixed }],
    notes: { type: String, default: '' }
  },
  status: {
    type: String,
    enum: ['success', 'partial', 'failed'],
    default: 'success'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Indexes for timeline queries
bulkImportHistorySchema.index({ tenantId: 1, createdAt: -1 });
bulkImportHistorySchema.index({ formId: 1, createdAt: -1 });
bulkImportHistorySchema.index({ actionType: 1, createdAt: -1 });

const BulkImportHistory = mongoose.model('BulkImportHistory', bulkImportHistorySchema);

export default BulkImportHistory;
