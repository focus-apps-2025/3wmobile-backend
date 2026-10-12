import Form from '../models/Form.js';
import AutoSendHistory from '../models/AutoSendHistory.js';
import mongoose from 'mongoose';
import { processAutoSend } from '../services/autoSendService.js';

export const updateAutoSendConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const { autoSendConfig } = req.body;

    const form = await Form.findOne({ id: id });
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check if we are starting/restarting
    const isStarting = autoSendConfig.status === 'active' && form.autoSendConfig?.status !== 'active';

    form.autoSendConfig = {
      ...form.autoSendConfig,
      ...autoSendConfig,
      // Calculate next scheduled time if enabled
      nextScheduledTime: autoSendConfig.enabled ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null
    };

    await form.save();

    // If starting, trigger immediate send
    if (isStarting) {
      console.log(`[AUTOSEND] Starting service for form ${id}, triggering immediate send`);
      // Run in background so response is not delayed
      processAutoSend(form).catch(err => console.error('[AUTOSEND] Immediate send failed:', err));
    }

    res.status(200).json({
      success: true,
      message: isStarting ? 'AutoSend started and initial report triggered' : 'AutoSend configuration updated successfully',
      data: form.autoSendConfig
    });
  } catch (error) {
    console.error('Update AutoSend config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAutoSendConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const form = await Form.findOne({ id: id });
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    res.status(200).json({
      success: true,
      data: form.autoSendConfig || { enabled: false, status: 'stopped' }
    });
  } catch (error) {
    console.error('Get AutoSend config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAutoSendHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const history = await AutoSendHistory.find({ formId: id })
      .sort({ sentAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await AutoSendHistory.countDocuments({ formId: id });

    res.status(200).json({
      success: true,
      data: {
        history,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get AutoSend history error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
