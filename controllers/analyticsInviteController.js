import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import Form from '../models/Form.js';
import AnalyticsInvite from '../models/AnalyticsInvite.js';
import Tenant from '../models/Tenant.js';
import { v4 as uuidv4 } from 'uuid';
import mailService from '../services/mailService.js';
import WhatsAppService from '../services/whatsappService.js';
import smsService from '../services/smsService.js';
import pdfService from '../services/pdfService.js';
import { generateGuestToken } from '../middleware/auth.js';

const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email.trim().toLowerCase());
};

const isValidPhone = (phone) => {
  if (!phone) return true; // Optional
  const digits = phone.toString().replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
};

const parseExcelFile = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  if (data.length < 2) throw new Error('Excel must have at least one data row');
  
  const headers = data[0].map(h => h?.toString().toLowerCase().trim() || '');
  
  // Look for CC column specifically
  const ccIdx = headers.findIndex(h => 
    h === 'cc' || h === 'cc sender' || h === 'cc_sender' || h === 'cc email' || h === 'cc_email' || 
    h === 'email (cc)' || h === 'email_cc' || h === 'cc recipients' || h.includes('carbon copy') || h === 'copy'
  );
  
  // Look for Main / Primary Email column (ignoring CC column)
  const emailIdx = headers.findIndex((h, idx) => 
    idx !== ccIdx && (
      h === 'main sender' || h === 'main_sender' || h === 'primary email' || h === 'primary_email' ||
      h === 'email (to)' || h === 'email_to' || h === 'to' || h === 'to email' || h === 'main email' ||
      h === 'email' || h.includes('email') || h.includes('mail')
    )
  );
  
  const typeIdx = headers.findIndex(h => h === 'type' || h === 'role' || h === 'recipient type' || h === 'category');
  const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('whatsapp'));
  
  if (emailIdx === -1 && ccIdx === -1) {
    throw new Error('Excel must contain an "Email", "Main Sender", or "CC Sender" column');
  }
  
  const records = [];
  const seen = new Set();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    
    const phone = phoneIdx !== -1 ? row[phoneIdx]?.toString().trim() : '';
    const rowType = typeIdx !== -1 ? row[typeIdx]?.toString().toLowerCase().trim() : '';
    const isRowCC = rowType.includes('cc') || rowType.includes('copy');

    // 1. Primary / Main email from main email column
    if (emailIdx !== -1 && row[emailIdx]) {
      const emailVal = row[emailIdx].toString().trim().toLowerCase();
      const emailList = emailVal.split(/[,;]+/).map(e => e.trim()).filter(Boolean);
      for (const e of emailList) {
        const itemType = isRowCC ? 'email_cc' : 'email';
        const key = `${itemType}:${e}`;
        if (!seen.has(key) && isValidEmail(e)) {
          seen.add(key);
          records.push({
            type: itemType,
            email: e,
            phone: phone || ''
          });
        }
      }
    }
    
    // 2. CC email from dedicated CC column
    if (ccIdx !== -1 && row[ccIdx]) {
      const ccVal = row[ccIdx].toString().trim().toLowerCase();
      const ccList = ccVal.split(/[,;]+/).map(c => c.trim()).filter(Boolean);
      for (const c of ccList) {
        const key = `email_cc:${c}`;
        if (!seen.has(key) && isValidEmail(c)) {
          seen.add(key);
          records.push({
            type: 'email_cc',
            email: c,
            phone: ''
          });
        }
      }
    }
  }
  return records;
};

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const uploadAnalyticsInvites = async (req, res) => {
  try {
    const { formId } = req.params;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    
    const normalizedFormId = formId ? formId.toString().trim() : '';
    const form = await Form.findOne({ 
      $or: [
        { id: normalizedFormId }, 
        { _id: mongoose.Types.ObjectId.isValid(normalizedFormId) ? normalizedFormId : new mongoose.Types.ObjectId() }
      ] 
    });
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    
    const records = parseExcelFile(req.file.buffer);
    const valid = [], invalid = [];
    
    records.forEach(r => {
      if (isValidEmail(r.email) && isValidPhone(r.phone)) {
        valid.push(r);
      } else {
        invalid.push(r);
      }
    });

    const toCount = valid.filter(r => r.type !== 'email_cc').length;
    const ccCount = valid.filter(r => r.type === 'email_cc').length;
    
    res.json({
      success: true,
      data: {
        total: records.length,
        valid: valid.length,
        invalid: invalid.length,
        toCount,
        ccCount,
        preview: valid.slice(0, 50)
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const sendAnalyticsInvites = async (req, res) => {
  try {
    const { formId } = req.params;
    const {
      invites,
      channels = ['email'],
      customMessage,
      pdfHtml,
      shareMode = 'excel',
      excelBase64,
      excelFileName
    } = req.body;
    
    if (!Array.isArray(invites) || invites.length === 0) {
      return res.status(400).json({ success: false, message: 'Invites array is required' });
    }
    
    const normalizedFormId = formId ? formId.toString().trim() : '';
    const form = await Form.findOne({ 
      $or: [
        { id: normalizedFormId }, 
        { _id: mongoose.Types.ObjectId.isValid(normalizedFormId) ? normalizedFormId : new mongoose.Types.ObjectId() }
      ] 
    });
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    
    const tenant = await Tenant.findById(form.tenantId);

    const includeLink = shareMode === 'link' || shareMode === 'both' || shareMode === 'all';
    const includePdf = shareMode === 'pdf' || shareMode === 'both' || shareMode === 'all';
    const includeExcel = shareMode === 'excel' || shareMode === 'both' || shareMode === 'all' || !!excelBase64;

    // Handle PDF generation if pdfHtml is provided
    let pdfAttachment = null;
    console.log('📩 SendAnalyticsInvites called with pdfHtml:', !!pdfHtml, 'excelBase64:', !!excelBase64, 'shareMode:', shareMode);
    
    if (pdfHtml && channels.includes('email') && includePdf) {
      try {
        console.log(`📄 Generating PDF for email attachment... HTML length: ${pdfHtml.length}`);
        const pdfBuffer = await pdfService.generatePDFWithA4Portrait(pdfHtml);
        if (pdfBuffer && pdfBuffer.length > 0) {
          pdfAttachment = {
            filename: `${form.title.replace(/\s+/g, '_')}_Analytics.pdf`,
            content: pdfBuffer
          };
          console.log(`✅ PDF generated successfully for attachment (${(pdfBuffer.length / 1024).toFixed(2)} KB)`);
        } else {
          console.error('❌ PDF generation returned empty buffer');
        }
      } catch (pdfError) {
        console.error('❌ Failed to generate PDF for attachment:', pdfError);
      }
    }

    // Handle Excel attachment if excelBase64 is provided
    let excelAttachment = null;
    if (excelBase64 && channels.includes('email') && includeExcel) {
      try {
        console.log(`📊 Processing Excel base64 attachment... Length: ${excelBase64.length}`);
        const excelBuffer = Buffer.from(excelBase64, 'base64');
        if (excelBuffer && excelBuffer.length > 0) {
          const safeTitle = (form.title || 'Responses').replace(/[^a-zA-Z0-9_-]/g, '_');
          excelAttachment = {
            filename: excelFileName || `${safeTitle}_Responses_${new Date().toISOString().slice(0, 10)}.xlsx`,
            content: excelBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          };
          console.log(`✅ Excel attachment created (${(excelBuffer.length / 1024).toFixed(2)} KB): ${excelAttachment.filename}`);
        }
      } catch (excelErr) {
        console.error('❌ Failed to process Excel base64 attachment:', excelErr);
      }
    }
    
    const results = [];
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry
    
    const baseUrl = process.env.INVITE_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
    // Handle comma-separated FRONTEND_URL
    const singleBaseUrl = baseUrl.split(',')[0].trim();
    const formattedBaseUrl = singleBaseUrl.endsWith('/') ? singleBaseUrl : `${singleBaseUrl}/`;
    const inviteLink = `${formattedBaseUrl}forms/${formId}/analytics/login`;
    
    // Extract CC emails to include on automated email delivery
    const ccEmails = invites
      .filter(r => (r.type === 'email_cc' || r.isCC) && r.email)
      .map(r => r.email.toLowerCase().trim());
    const uniqueCcEmails = Array.from(new Set(ccEmails));

    // Determine target primary invites to send to
    const primaryInvites = invites.filter(r => r.type !== 'email_cc' && !r.isCC && r.email);
    const targetEmailInvites = primaryInvites.length > 0 ? primaryInvites : invites.filter(r => r.email || r.phone);

    console.log(`[AUTOMAIL] Dispatching analytics invites: ${targetEmailInvites.length} primary recipient(s), ${uniqueCcEmails.length} CC recipient(s), Excel Attached: ${!!excelAttachment}`);

    // Process invites in batches to avoid overloading and timeouts
    const batchSize = 10;
    for (let i = 0; i < targetEmailInvites.length; i += batchSize) {
      const batch = targetEmailInvites.slice(i, i + batchSize);
      const batchPromises = batch.map(async (inviteData) => {
        const email = inviteData.email ? inviteData.email.toLowerCase().trim() : null;
        const { phone } = inviteData;
        const otp = generateOTP();
        
        // Create new invite for each request (allows duplicates)
        await AnalyticsInvite.create({
          formId: form.id || form._id.toString(),
          email,
          phone, 
          otp, 
          expiresAt, 
          status: 'sent', 
          tenantId: form.tenantId 
        });

        // Also ensure any CC emails have an invite record in database for OTP / login access
        for (const ccEmail of uniqueCcEmails) {
          if (ccEmail !== email) {
            await AnalyticsInvite.create({
              formId: form.id || form._id.toString(),
              email: ccEmail,
              otp,
              expiresAt,
              status: 'sent',
              tenantId: form.tenantId
            }).catch(err => console.warn('Could not store CC invite record:', err.message));
          }
        }
        
        let emailSent = false;
        let whatsappSent = false;
        let smsSent = false;
        let emailError = null;

        if (channels.includes('email') && email) {
          // Never include the current recipient in their own CC list
          const relevantCc = uniqueCcEmails.filter(c => c.toLowerCase() !== email.toLowerCase());
          console.log(`📧 Attempting automated email to: ${email} with CC: [${relevantCc.join(', ')}]`);
          // Automated mail dispatch via server mailService (SMTP/MailerSend) directly without Gmail app switching
          const mailResult = await mailService.sendAnalyticsInvite(
            email, 
            form.title, 
            inviteLink, 
            otp, 
            tenant?.name || '3W Inspection', 
            customMessage, 
            false, 
            pdfAttachment, 
            includeLink, 
            relevantCc,
            excelAttachment
          );
          emailSent = mailResult.success;
          if (!emailSent) {
            emailError = mailResult.error;
            console.error(`❌ Automated email failed for ${email}:`, emailError);
          }
        }
        
        if (channels.includes('whatsapp') && phone) {
          console.log(`📱 Attempting WhatsApp to: ${phone}`);
          const waResult = await WhatsAppService.sendAnalyticsInvite(phone, form.title, inviteLink, null, tenant?.name || '3W Inspection', email, customMessage, false, includeLink);
          whatsappSent = waResult.success;
          if (!whatsappSent) {
            console.error(`❌ WhatsApp failed for ${phone}:`, waResult.error);
          }
        }

        if (channels.includes('sms') && phone) {
          console.log(`💬 Attempting SMS to: ${phone}`);
          const smsResult = await smsService.sendFormInvite(phone, form.title, inviteLink, tenant?.name || '3W Inspection');
          smsSent = smsResult.success;
          if (!smsSent) {
            console.error(`❌ SMS failed for ${phone}:`, smsResult.error);
          }
        }
        
        return { 
          email, 
          phone,
          status: (emailSent || whatsappSent || smsSent) ? 'sent' : 'failed',
          emailSent,
          whatsappSent,
          smsSent,
          deliveryReport: {
            email: emailSent ? 'success' : (channels.includes('email') && email ? 'failed' : 'skipped'),
            emailError: emailError,
            whatsapp: whatsappSent ? 'success' : (channels.includes('whatsapp') && phone ? 'failed' : 'skipped'),
            sms: smsSent ? 'success' : (channels.includes('sms') && phone ? 'failed' : 'skipped')
          }
        };
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    // Register invites for CC recipients so they also have valid login access
    for (const ccEmail of uniqueCcEmails) {
      try {
        await AnalyticsInvite.create({
          formId: form.id,
          email: ccEmail,
          phone: '',
          otp: generateOTP(),
          expiresAt,
          status: 'sent',
          tenantId: form.tenantId
        });
      } catch (ccErr) {
        console.warn('Failed to record CC invite record:', ccErr.message);
      }
    }
    
    const sentCount = results.filter(r => r.status === 'sent').length;
    const allSuccessful = results.length > 0 && results.every(r => 
      (!channels.includes('email') || r.emailSent) && 
      (!channels.includes('whatsapp') || !r.phone || r.whatsappSent) &&
      (!channels.includes('sms') || !r.phone || r.smsSent)
    );

    res.json({ 
      success: sentCount > 0, 
      sent: sentCount,
      failed: results.length - sentCount,
      allSuccessful,
      primarySent: targetEmailInvites.length,
      ccCount: uniqueCcEmails.length,
      data: { 
        sent: sentCount,
        failed: results.length - sentCount,
        allSuccessful,
        details: results
      },
      message: allSuccessful 
        ? `Successfully sent ${sentCount} invites (with ${uniqueCcEmails.length} CC recipient${uniqueCcEmails.length === 1 ? '' : 's'})` 
        : (sentCount > 0 
          ? `Sent ${sentCount} invites, but ${results.length - sentCount} failed. Check server logs for details.` 
          : 'Failed to send invites. Please verify email and channel configuration.')
    });
  } catch (error) {
    console.error('Send analytics invites error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const requestGuestOTP = async (req, res) => {
  try {
    let { formId, email, phone } = req.body;

    if (!formId || (!email && !phone)) {
      return res.status(400).json({ success: false, message: 'Form ID and either email or phone are required' });
    }

    const normalizedFormId = formId.toString().trim();
    const normalizedEmail = email ? email.toString().toLowerCase().trim() : null;
    const cleanPhone = phone ? phone.toString().replace(/\D/g, '') : null;

    const form = await Form.findOne({ 
      $or: [
        { id: normalizedFormId }, 
        { _id: mongoose.Types.ObjectId.isValid(normalizedFormId) ? normalizedFormId : new mongoose.Types.ObjectId() }
      ] 
    });

    const inviteConditions = [];
    if (normalizedEmail) {
      inviteConditions.push({ email: normalizedEmail });
    }
    if (cleanPhone) {
      const phoneRegex = cleanPhone.length >= 10 ? new RegExp(cleanPhone.slice(-10) + '$') : new RegExp(cleanPhone + '$');
      inviteConditions.push({ phone: phoneRegex });
      inviteConditions.push({ phone: cleanPhone });
    }

    const formIds = [normalizedFormId];
    if (form) {
      if (form.id) formIds.push(form.id);
      if (form._id) formIds.push(form._id.toString());
    }

    const invite = await AnalyticsInvite.findOne({ 
      formId: { $in: formIds },
      $or: inviteConditions
    });
    
    if (!invite) {
      const identity = normalizedEmail || phone;
      console.log(`[AUTH] Invite not found for ${identity} on form: ${normalizedFormId}`);
      return res.status(404).json({ 
        success: false, 
        message: 'This identity is not invited to view analytics for this form. Please contact the administrator.' 
      });
    }
    
    invite.status = 'active';
    invite.lastLogin = new Date();
    await invite.save();
    
    // Generate guest token
    const token = generateGuestToken(invite.email || invite.phone, invite.formId);
    
    res.json({ 
      success: true, 
      data: { 
        token,
        email: invite.email, 
        phone: invite.phone,
        formId: invite.formId,
        expiresAt: invite.expiresAt
      } 
    });

  } catch (error) {
    console.error('Request guest OTP error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyAnalyticsOTP = async (req, res) => {
  try {
    const { formId, email, phone, otp } = req.body;
    
    if (!formId || (!email && !phone) || !otp) {
      return res.status(400).json({ success: false, message: 'Form ID, OTP, and either email or phone are required' });
    }

    const normalizedFormId = formId.toString().trim();
    const normalizedEmail = email ? email.toString().toLowerCase().trim() : null;
    const cleanPhone = phone ? phone.toString().replace(/\D/g, '') : null;

    // 1. Try to find the form
    const form = await Form.findOne({ 
      $or: [
        { id: normalizedFormId }, 
        { _id: mongoose.Types.ObjectId.isValid(normalizedFormId) ? normalizedFormId : new mongoose.Types.ObjectId() }
      ] 
    });

    // 2. Build search query for invite
    const inviteConditions = [];
    if (normalizedEmail) {
      inviteConditions.push({ email: normalizedEmail });
    }
    if (cleanPhone) {
      const phoneRegex = cleanPhone.length >= 10 ? new RegExp(cleanPhone.slice(-10) + '$') : new RegExp(cleanPhone + '$');
      inviteConditions.push({ phone: phoneRegex });
      inviteConditions.push({ phone: cleanPhone });
    }

    const formIds = [normalizedFormId];
    if (form) {
      if (form.id) formIds.push(form.id);
      if (form._id) formIds.push(form._id.toString());
    }

    const invite = await AnalyticsInvite.findOne({ 
      formId: { $in: formIds },
      $or: inviteConditions
    });
    
    if (!invite) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }
    
    if (invite.otp !== otp) {
      return res.status(401).json({ success: false, message: 'Invalid verification code (OTP)' });
    }
    
    if (new Date() > invite.expiresAt) {
      invite.status = 'expired';
      await invite.save();
      return res.status(401).json({ success: false, message: 'Invite has expired' });
    }
    
    invite.status = 'active';
    invite.lastLogin = new Date();
    await invite.save();
    
    // Generate guest token
    const token = generateGuestToken(invite.email || invite.phone, invite.formId);
    
    res.json({ 
      success: true, 
      data: { 
        token,
        email: invite.email, 
        phone: invite.phone,
        formId: invite.formId,
        expiresAt: invite.expiresAt
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
