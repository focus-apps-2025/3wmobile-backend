import cron from 'node-cron';
import Form from '../models/Form.js';
import AutoSendHistory from '../models/AutoSendHistory.js';
import mailService from './mailService.js';
import whatsappService from './whatsappService.js';
import pdfService from './pdfService.js';
import Tenant from '../models/Tenant.js';

export const initAutoSendJob = () => {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[AUTOSEND] Checking for scheduled sends...');
    try {
      const now = new Date();
      const formsToProcess = await Form.find({
        'autoSendConfig.enabled': true,
        'autoSendConfig.status': 'active',
        'autoSendConfig.nextScheduledTime': { $lte: now }
      });

      console.log(`[AUTOSEND] Found ${formsToProcess.length} forms to process`);

      for (const form of formsToProcess) {
        await processAutoSend(form);
      }
    } catch (error) {
      console.error('[AUTOSEND] Error in cron job:', error);
    }
  });
};

export const processAutoSend = async (form) => {
  const { autoSendConfig, id: formId, tenantId } = form;
  const { recipients, includePdf, includeLink } = autoSendConfig;

  console.log(`[AUTOSEND] Processing form ${formId} for ${recipients.length} recipients`);

  const tenant = await Tenant.findById(tenantId);
  const tenantName = tenant ? tenant.name : '3W-WHEELER';

  let pdfAttachment = null;
  if (includePdf) {
    try {
      // For now, we generate a basic summary HTML if we don't have a full report generator on server
      // Ideally, we'd reuse the same logic as the frontend but that's hard on server without a browser-like environment for React
      const summaryHtml = `
        <html>
          <body>
            <h1>Analytics Summary: ${form.title}</h1>
            <p>Date: ${new Date().toLocaleDateString()}</p>
            <p>This is an automated report for ${form.title}.</p>
            <p>Please visit the dashboard for full details.</p>
          </body>
        </html>
      `;
      const pdfBuffer = await pdfService.generatePDFWithA4Portrait(summaryHtml);
      if (pdfBuffer && pdfBuffer.length > 0) {
        pdfAttachment = {
          filename: `${form.title.replace(/\s+/g, '_')}_Analytics.pdf`,
          content: pdfBuffer
        };
      }
    } catch (error) {
      console.error(`[AUTOSEND] Failed to generate PDF for form ${formId}:`, error);
    }
  }

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const singleBaseUrl = baseUrl.split(',')[0].trim();
  const formattedBaseUrl = singleBaseUrl.endsWith('/') ? singleBaseUrl : `${singleBaseUrl}/`;
  const inviteLink = `${formattedBaseUrl}forms/${formId}/analytics/login`;
  const ccEmails = recipients.filter(r => r.type === 'email_cc').map(r => r.value);
  const primaryEmails = recipients.filter(r => r.type === 'email');

  for (const recipient of recipients) {
    try {
      if (recipient.type === 'email') {
        await mailService.sendAnalyticsInvite(
          recipient.value,
          form.title,
          inviteLink,
          null, // otp
          tenantName,
          "Automated daily analytics report.",
          false, // isOTPRequest
          pdfAttachment,
          includeLink,
          ccEmails
        );
      } else if (recipient.type === 'whatsapp') {
        await whatsappService.sendAnalyticsInvite(
          recipient.value,
          form.title,
          inviteLink,
          null, // otp
          tenantName,
          recipient.value, // email placeholder
          "Automated daily analytics report.",
          false, // isOTPRequest
          includeLink
        );
      } else if (recipient.type === 'email_cc') {
        if (primaryEmails.length === 0) {
          throw new Error("Cannot send CC without a primary email recipient (To)");
        }
      }
      // Log success
      await AutoSendHistory.create({
        formId,
        tenantId,
        type: recipient.type,
        recipient: recipient.value,
        status: 'success',
        details: { includePdf, includeLink }
      });

    } catch (error) {
      console.error(`[AUTOSEND] Failed to send to ${recipient.value}:`, error);
      
      // Log failure
      await AutoSendHistory.create({
        formId,
        tenantId,
        type: recipient.type,
        recipient: recipient.value,
        status: 'failed',
        details: { 
          includePdf, 
          includeLink,
          error: error.message 
        }
      });
    }
  }

  // Update lastSent and nextScheduledTime
  form.autoSendConfig.lastSent = new Date();
  form.autoSendConfig.nextScheduledTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await form.save();
};
