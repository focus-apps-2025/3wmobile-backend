import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  settingType: {
    type: String,
    required: true,
    unique: true,
    enum: ['global'],
    default: 'global'
  },
  defaultLogo: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

const Settings = mongoose.model('Settings', settingsSchema);

export default Settings;
