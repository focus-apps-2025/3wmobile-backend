import WhatsAppService from '../services/whatsappService.js';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import Form from '../models/Form.js';
import FormInvite from '../models/FormInvite.js';
import Tenant from '../models/Tenant.js';

// Helper: Validate phone format (basic)
const isValidPhone = (phone) => {
  if (!phone) return false;
  
  const phoneStr = phone.toString().trim();
  
  // Remove all non-digit characters except +
  const cleaned = phoneStr.replace(/[^\d+]/g, '');
  
  // Basic validation: 10-15 digits
  const digitCount = cleaned.replace(/\D/g, '').length;
  return digitCount >= 10 && digitCount <= 15;
};

// Helper: Parse Excel file for WhatsApp
const parseWhatsAppExcel = (buffer) => {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (data.length < 2) {
      throw new Error('Excel file must have at least one data row');
    }
    
    const headers = data[0].map(h => h ? h.toString().toLowerCase().trim() : '');
    
    const phoneIndex = headers.findIndex(h => 
      h.includes('phone') || h.includes('mobile') || h.includes('contact') || h === 'phone'
    );
    
    const emailIndex = headers.findIndex(h => 
      h.includes('email') || h.includes('mail') || h === 'email'
    );
    
    if (phoneIndex === -1) {
      throw new Error('Excel must contain a "Phone" column');
    }
    
    const records = [];
    const seenPhones = new Set();
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;
      
      let phone = '';
      if (row[phoneIndex] !== undefined && row[phoneIndex] !== null) {
        phone = row[phoneIndex].toString().trim();
        // Keep original for validation but clean for storage
        const cleanPhone = phone.replace(/[^\d+]/g, '');
        
        if (cleanPhone && !seenPhones.has(cleanPhone)) {
          seenPhones.add(cleanPhone);
          
          let email = '';
          if (emailIndex !== -1 && row[emailIndex] !== undefined && row[emailIndex] !== null) {
            email = row[emailIndex].toString().trim().toLowerCase();
          }
          
          records.push({
            phone: cleanPhone,
            originalPhone: phone,
            email
          });
        }
      }
    }
    
    return records;
  } catch (error) {
    throw new Error(`Failed to parse Excel file: ${error.message}`);
  }
};

export const uploadWhatsAppInvites = async (req, res) => {
  try {
    const { formId } = req.params;
    
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'No Excel file provided'
      });
    }
    
    const form = await Form.findOne({ id: formId });
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }
    
    const records = parseWhatsAppExcel(req.file.buffer);
    
    const validRecords = [];
    const invalidRecords = [];
    const seenPhones = new Set();
    
    for (const record of records) {
      if (isValidPhone(record.phone)) {
        validRecords.push({
          phone: record.phone,
          email: record.email || '',
          status: 'valid'
        });
        seenPhones.add(record.phone);
      } else {
        invalidRecords.push({
          phone: record.originalPhone,
          issues: ['Invalid phone format']
        });
      }
    }
    
    // Check existing invites
    const existingInvites = await FormInvite.find({
      formId,
      phone: { $in: validRecords.map(r => r.phone) }
    }).select('phone status');
    
    const existingMap = new Map();
    existingInvites.forEach(invite => {
      existingMap.set(invite.phone, invite.status);
    });
    
    const preview = validRecords.map(record => ({
      ...record,
      existingStatus: existingMap.get(record.phone) || null
    }));
    
    const tenant = await Tenant.findById(form.tenantId);
    const tenantSlug = tenant?.slug || 'public';
    const baseUrlRaw = process.env.INVITE_FRONTEND_URL || 'https://3wheelertvs.focusengineeringapp.com/';
    const baseUrl = baseUrlRaw.endsWith('/') ? baseUrlRaw : `${baseUrlRaw}/`;
    
    res.json({
      success: true,
      message: 'Excel processed successfully',
      data: {
        totalRecords: records.length,
        valid: validRecords.length,
        invalid: invalidRecords.length,
        duplicatePhones: records.length - seenPhones.size,
        preview: preview.slice(0, 10),
        sampleLink: `${baseUrl}${tenantSlug}/forms/${formId}?inviteId=SAMPLE_INVITE_ID`,
        form: {
          id: form.id,
          title: form.title,
          inviteOnlyTracking: form.inviteOnlyTracking || false
        }
      }
    });
    
  } catch (error) {
    console.error('Upload WhatsApp invites error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to process Excel file'
    });
  }
};

export const sendWhatsAppInvites = async (req, res) => {
  try {
    const { formId } = req.params;
    const { phones } = req.body; // Array of { phone, email }
    
    if (!Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Phones array is required'
      });
    }
    
    const form = await Form.findOne({ id: formId });
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }
    
    const tenant = await Tenant.findById(form.tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    const results = [];
    const failed = [];
    
    // Process in parallel with Promise.all
    const invitePromises = phones.map(async (record) => {
      try {
        const phone = record.phone.trim();
        const email = record.email ? record.email.toLowerCase().trim() : '';
        
        let invite = await FormInvite.findOne({
          formId,
          phone
        });
        
        // If already responded, we create a NEW invite record to allow tracking a new submission
        const isResponded = invite && invite.status === 'responded';
        const inviteId = isResponded || !invite ? uuidv4() : invite.inviteId;
        const baseUrlRaw = process.env.INVITE_FRONTEND_URL || 'https://3wheelertvs.focusengineeringapp.com/';
        const baseUrl = baseUrlRaw.endsWith('/') ? baseUrlRaw : `${baseUrlRaw}/`;
        const inviteLink = `${baseUrl}${tenant.slug}/forms/${formId}?inviteId=${inviteId}`;
        
        const whatsappResult = await WhatsAppService.sendFormInvite(
          phone,
          form.title,
          inviteLink,
          tenant.name
        );
        
        if (whatsappResult.success) {
          if (invite && !isResponded) {
            invite.sentAt = new Date();
            if (!invite.notificationChannels) {
              invite.notificationChannels = [];
            }
            if (!invite.notificationChannels.includes('whatsapp')) {
              invite.notificationChannels.push('whatsapp');
            }
            await invite.save();
          } else {
            // Create new invite (either first time or after response)
            const newInvite = new FormInvite({
              formId,
              tenantId: form.tenantId,
              phone,
              email: email || undefined,
              inviteId,
              status: 'sent',
              notificationChannels: ['whatsapp'],
              createdBy: req.user?._id,
              previousInviteId: isResponded ? invite.inviteId : undefined
            });
            await newInvite.save();
          }
          
          results.push({
            phone,
            status: 'sent',
            inviteId,
            strategy: whatsappResult.strategy,
            twilioStatus: whatsappResult.status
          });
        } else {
          failed.push({
            phone,
            reason: whatsappResult.error,
            details: whatsappResult.details // If we add details later
          });
        }
      } catch (error) {
        failed.push({
          phone: record.phone,
          reason: error.message
        });
      }
    });

    await Promise.all(invitePromises);
    
    // Only return success: true if at least one message was sent successfully
    const overallSuccess = results.length > 0;

    res.json({
      success: overallSuccess,
      message: overallSuccess 
        ? `Successfully sent ${results.length} WhatsApp invites`
        : `Failed to send any WhatsApp invites. ${failed.length} failures.`,
      data: {
        sent: results.length,
        failed: failed.length,
        results,
        failures: failed
      }
    });
    
  } catch (error) {
    console.error('Send WhatsApp invites error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send WhatsApp invites',
      error: error.message
    });
  }
};

export const sendServiceRequestNotification = async (req, res) => {
  try {
    const { serviceRequest, customerInfo } = req.body;

    if (!serviceRequest || !customerInfo) {
      return res.status(400).json({
        success: false,
        message: 'Service request and customer information are required'
      });
    }

    if (!customerInfo.phone) {
      return res.status(400).json({
        success: false,
        message: 'Customer phone number is required for WhatsApp'
      });
    }

    const shopNotification = await WhatsAppService.sendServiceRequestNotification(serviceRequest, customerInfo);
    
    const customerConfirmation = await WhatsAppService.sendCustomerConfirmation(serviceRequest, customerInfo);

    res.json({
      success: true,
      message: 'WhatsApp notifications sent successfully',
      data: {
        shopNotification,
        customerConfirmation
      }
    });

  } catch (error) {
    console.error('Error in sendServiceRequestNotification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send WhatsApp notifications',
      error: error.message
    });
  }
};

export const sendStatusUpdate = async (req, res) => {
  try {
    const { serviceRequest, customerInfo, status, message, estimatedCompletion } = req.body;

    if (!serviceRequest || !customerInfo || !status || !message) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required (serviceRequest, customerInfo, status, message)'
      });
    }

    if (!customerInfo.phone) {
      return res.status(400).json({
        success: false,
        message: 'Customer phone number is required'
      });
    }

    const result = await WhatsAppService.sendStatusUpdate(
      serviceRequest, 
      customerInfo, 
      status, 
      message, 
      estimatedCompletion
    );

    res.json({
      success: true,
      message: 'WhatsApp status update sent successfully',
      data: result
    });

  } catch (error) {
    console.error('Error in sendStatusUpdate:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send WhatsApp status update',
      error: error.message
    });
  }
};

export const testWhatsAppConnection = async (req, res) => {
  try {
    const result = await WhatsAppService.testConnection();
    
    res.json({
      success: result.success,
      message: result.success ? 'WhatsApp service is working correctly' : 'WhatsApp service connection failed',
      data: result
    });

  } catch (error) {
    console.error('Error testing WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test WhatsApp connection',
      error: error.message
    });
  }
};

export const sendTestWhatsAppMessage = async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    const result = await WhatsAppService.sendTestMessage(phone);
    
    res.json({
      success: true,
      message: 'Test WhatsApp message sent successfully',
      data: result
    });

  } catch (error) {
    console.error('Error sending test WhatsApp message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test WhatsApp message',
      error: error.message
    });
  }
};

export const sendResponseReport = async (req, res) => {
  try {
    console.log('📱 sendResponseReport (WhatsApp) called');
    console.log('User:', req.user?.email, 'Role:', req.user?.role);
    console.log('req.body:', req.body);

    const { phone, subject } = req.body;

    console.log('Phone:', phone);
    console.log('Subject:', subject);

    if (!phone) {
      console.error('❌ Missing phone number');
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    if (!subject) {
      console.error('❌ Missing subject');
      return res.status(400).json({
        success: false,
        message: 'Subject is required'
      });
    }

    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    console.log('Sending WhatsApp report notification...');
    const result = await WhatsAppService.sendResponseReport(
      phone,
      subject,
      null,
      null
    );

    if (!result.success) {
      console.error('❌ WhatsAppService returned error:', result.error);
      return res.status(500).json({
        success: false,
        message: 'Failed to send WhatsApp notification',
        error: result.error
      });
    }

    console.log('✅ Report notification sent successfully via WhatsApp');
    res.json({
      success: true,
      message: 'Report notification sent successfully via WhatsApp',
      data: result
    });

  } catch (error) {
    console.error('❌ Error in sendResponseReport (WhatsApp):', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send report notification',
      error: error.message
    });
  }
};

export const testResponseReportWhatsApp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    const result = await WhatsAppService.sendResponseReport(
      phone,
      'Test Report - Response Report System',
      null,
      null
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Test WhatsApp notification sent successfully!',
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test WhatsApp notification',
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error in testResponseReportWhatsApp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test WhatsApp notification',
      error: error.message
    });
  }
};
