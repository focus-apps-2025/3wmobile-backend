import mongoose from 'mongoose';

const FileSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true
  },
  originalName: {
    type: String,
    required: true
  },
  mimetype: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true
  },
  gridfsId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  cloudinaryPublicId: {
    type: String,
    default: null
  },
  cloudinaryUrl: {
    type: String,
    default: null
  },
  url: {
    type: String,
    required: true
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  associatedWith: {
    type: {
      type: String,
      enum: ['form', 'response', 'profile', 'logo'],
      required: true
    },
    id: String
  },
  isPublic: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for efficient queries
FileSchema.index({ uploadedBy: 1 });
FileSchema.index({ 'associatedWith.type': 1, 'associatedWith.id': 1 });
FileSchema.index({ filename: 1 });
FileSchema.index({ cloudinaryPublicId: 1 });

const File = mongoose.model('File', FileSchema);

export default File;