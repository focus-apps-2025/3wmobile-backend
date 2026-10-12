import twilio from 'twilio';

class WhatsAppService {
  constructor() {
    // Use Production (WA_) credentials if available, otherwise fallback to standard/sandbox ones
    const accountSid = process.env.WA_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.WA_TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
    
    this.isConfigured = !!(accountSid && authToken);
    
    if (!this.isConfigured) {
      const missing = [];
      if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
      if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
      console.warn(`⚠️ WhatsApp service not fully configured. Missing: ${missing.join(', ')}`);
      this.client = null;
    } else {
      this.client = twilio(accountSid, authToken);
    }
    
    // Prioritize Production WhatsApp number and template
    this.twilioPhoneNumber = process.env.WA_TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_WHATSAPP_NUMBER || '';
    this.inviteTemplateSid = process.env.WA_TWILIO_INVITE_TEMPLATE_SID || process.env.TWILIO_INVITE_TEMPLATE_SID || '';
    this.analyticsTemplateSid = process.env.WA_TWILIO_ANALYTICS_TEMPLATE_SID || process.env.TWILIO_ANALYTICS_TEMPLATE_SID || '';
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');
    
    // If it starts with 91 and has 12 digits, it's an Indian number with country code
    if (cleaned.startsWith('91') && cleaned.length === 12) {
      return `+${cleaned}`;
    }
    
    // If it's 10 digits, we need to be careful. 
    // In this specific environment (India), we should probably default to +91 if not specified
    if (cleaned.length === 10) {
      // If we're sure this is for India, use +91. Otherwise, keep +1 for US as before
      // but let's make it smarter: if the user provided +91 in the original string, 
      // the first branch or the startsWith branch will handle it.
      return `+91${cleaned}`; 
    }
    
    return `+${cleaned}`;
  }

  async sendServiceRequestNotification(serviceRequest, customerInfo) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const customerPhone = this.formatPhoneNumber(customerInfo.phone);
      if (!customerPhone) {
        return { success: false, error: 'Invalid customer phone number' };
      }

      const shopPhone = process.env.TWILIO_SHOP_WHATSAPP || '';
      if (!shopPhone) {
        return { success: false, error: 'Shop WhatsApp number not configured' };
      }

      const message = `
🚗 *NEW SERVICE REQUEST*

*Customer Information:*
Name: ${customerInfo.name}
Email: ${customerInfo.email}
Phone: ${customerInfo.phone}

*Vehicle Information:*
Make: ${serviceRequest.vehicleMake}
Model: ${serviceRequest.vehicleModel}
Year: ${serviceRequest.vehicleYear || 'Not specified'}
License Plate: ${serviceRequest.licensePlate || 'Not provided'}

*Service Details:*
Service Type: ${serviceRequest.serviceType}
Issue: ${serviceRequest.issueDescription}
${serviceRequest.urgency ? `Urgency: ${serviceRequest.urgency}` : ''}
${serviceRequest.preferredDate ? `Preferred Date: ${serviceRequest.preferredDate}` : ''}

Request ID: ${serviceRequest.id || 'N/A'}
Submitted: ${new Date().toLocaleString()}
      `.trim();

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${shopPhone}`,
        body: message,
      });

      console.log('Service request notification sent to shop:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending service request notification:', error);
      return { success: false, error: error.message };
    }
  }

  async sendCustomerConfirmation(serviceRequest, customerInfo) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const customerPhone = this.formatPhoneNumber(customerInfo.phone);
      if (!customerPhone) {
        return { success: false, error: 'Invalid customer phone number' };
      }

      const message = `
✅ *SERVICE REQUEST RECEIVED*

Dear ${customerInfo.name},

Thank you for choosing Focus Auto Shop! We have received your service request.

*Your Request Summary:*
Vehicle: ${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel} ${serviceRequest.vehicleYear || ''}
Service Type: ${serviceRequest.serviceType}
Issue: ${serviceRequest.issueDescription}

*What Happens Next?*
📋 Our team will review within 24 hours
📞 We'll contact you to schedule
🔧 Our mechanics will diagnose & fix

*Need Help?*
Call: (555) 123-4567
Email: support@focus-auto.com

Request ID: ${serviceRequest.id || 'N/A'}
      `.trim();

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${customerPhone}`,
        body: message,
      });

      console.log('Customer confirmation sent:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending customer confirmation:', error);
      return { success: false, error: error.message };
    }
  }

  async sendFormInvite(phone, formTitle, inviteLink, tenantName) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const customerPhone = this.formatPhoneNumber(phone);
      if (!customerPhone) {
        return { success: false, error: 'Invalid phone number' };
      }

      console.log('📱 Preparing WhatsApp Invite...');
      console.log('Template SID:', this.inviteTemplateSid);
      
      let messageData;
      
      if (this.inviteTemplateSid) {
        // CLEANING: WhatsApp is extremely strict about variables.
        // We remove characters that often cause template rejection.
        const safe = (val, max = 200) => {
          if (!val) return "";
          return String(val)
            .replace(/[\r\n\t]/g, " ") // No newlines
            .replace(/[\\\"']/g, "")   // No quotes or backslashes
            .trim()
            .substring(0, max);
        };

        let v1 = String(inviteLink || "").trim();
        const v2 = safe(tenantName, 60);
        const v3 = safe(formTitle, 150);

        // FIX: WhatsApp rejects localhost links. Replace with a valid domain for testing if needed.
        if (v1.includes('localhost') || v1.includes('127.0.0.1')) {
          console.warn('⚠️ WARNING: Localhost link detected. Replacing with placeholder to avoid Error 63005.');
          v1 = 'https://3wheelertvs.focusengineeringapp.com/analytics-placeholder/';
        }

        console.log('📱 WhatsApp Variable Values:');
        console.log('   {{1}} (Link):', v1);
        console.log('   {{2}} (Tenant):', v2);
        console.log('   {{3}} (Form):', v3);

        const attempts = [
          { name: 'Standard Keys', vars: { "1": v1, "2": v2, "3": v3 } },
          { name: 'Mustache Keys', vars: { "{{1}}": v1, "{{2}}": v2, "{{3}}": v3 } }
        ];

        for (const attempt of attempts) {
          try {
            console.log(`📱 Testing Strategy: ${attempt.name}`);
            
            // Try sending as a raw object (Twilio SDK often prefers this for contentVariables)
            messageData = await this.client.messages.create({
              from: `whatsapp:${this.twilioPhoneNumber}`,
              to: `whatsapp:${customerPhone}`,
              contentSid: this.inviteTemplateSid.trim(),
              contentVariables: JSON.stringify(attempt.vars)
            });
            
            console.log(`✅ Strategy ${attempt.name} accepted. SID: ${messageData.sid}, Status: ${messageData.status}`);
            
            if (messageData.status === 'failed') {
              console.warn(`❌ Strategy ${attempt.name} failed instantly with code: ${messageData.errorCode}`);
              continue;
            }

            return { 
              success: true, 
              messageId: messageData.sid, 
              strategy: attempt.name,
              status: messageData.status 
            };
          } catch (err) {
            console.error(`❌ Strategy ${attempt.name} API Error:`, err.code, err.message);
          }
        }

        // Final Fallback (Template without variables - check if it's a static template error)
        try {
          console.log('Testing Strategy: No-Vars');
          messageData = await this.client.messages.create({
            from: `whatsapp:${this.twilioPhoneNumber}`,
            to: `whatsapp:${customerPhone}`,
            contentSid: this.inviteTemplateSid.trim()
          });
          return { success: true, messageId: messageData.sid, strategy: 'No-Vars' };
        } catch (e) {
          console.error('All template strategies exhausted.');
        }

        // Last resort: Fallback to plain text only if we absolutely have to
        // Note: This may get 63005 if the user hasn't messaged the business first
        console.error('All template attempts failed. Attempting plain text fallback...');
        const body = `📋 *FORM INVITATION*\n\nHello! You have been invited by *${v1}* to fill out the form: *${v2}*\n\nPlease click here: ${v3}`;
        messageData = await this.client.messages.create({
          from: `whatsapp:${this.twilioPhoneNumber}`,
          to: `whatsapp:${customerPhone}`,
          body: body
        });
        return { success: true, messageId: messageData.sid, strategy: 'Fallback-Text', note: 'fallback' };
      } else {
        // Fallback to legacy body (only works in open sessions or sandbox)
        const message = `
📋 *FORM INVITATION*

Hello! You have been invited by *${tenantName}* to fill out the following form:

*Form Name:*
*${formTitle}*

Please click the link below to complete the form:
${inviteLink}

Thank you!
      `.trim();

        messageData = await this.client.messages.create({
          from: `whatsapp:${this.twilioPhoneNumber}`,
          to: `whatsapp:${customerPhone}`,
          body: message,
        });
      }

      console.log('Form invite sent via WhatsApp:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending form invite via WhatsApp:', error);
      return { success: false, error: error.message };
    }
  }

  // Send analytics dashboard invite via WhatsApp
  async sendAnalyticsInvite(phone, formTitle, inviteLink, otp, tenantName, email, customMessage = "", isOTPRequest = false, includeLink = true) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const customerPhone = this.formatPhoneNumber(phone);
      if (!customerPhone) {
        return { success: false, error: 'Invalid phone number' };
      }

      // In production, we MUST use a template to initiate conversation.
      const templateSid = this.analyticsTemplateSid || this.inviteTemplateSid;
      if (templateSid) {
        // WhatsApp is extremely strict about variables.
        // We remove characters that often cause template rejection.
        const safe = (val, max = 200) => {
          if (!val) return "";
          return String(val)
            .replace(/[\r\n\t]/g, " ") // No newlines
            .replace(/[\\\"']/g, "")   // No quotes or backslashes
            .trim()
            .substring(0, max);
        };

        let v1 = includeLink ? String(inviteLink || "").trim() : "Analytics Report (See Email)";
        const v2 = safe(tenantName || '3W-WHEELER', 60);
        const v3 = safe(formTitle || 'Analytics', 150);
        
        // FIX: WhatsApp rejects localhost links. Replace with a valid domain for testing if needed.
        if (includeLink && (v1.includes('localhost') || v1.includes('127.0.0.1'))) {
          console.warn('⚠️ WARNING: Localhost link detected. Replacing with placeholder to avoid Error 63005.');
          v1 = 'https://3wheelertvs.focusengineeringapp.com/analytics-placeholder/';
        }

        const v4 = safe(email || '(Your Email)', 100);
        const v5 = safe(otp || 'Requested on Login', 50);

        console.log('📱 Sending Analytics Invite via Template:', templateSid);
        
        const baseVars = { "1": v1, "2": v2, "3": v3 };
        if (this.analyticsTemplateSid) {
          Object.assign(baseVars, { "4": v4, "5": v5 });
        }

        const attempts = [
          { name: 'Standard Keys', vars: baseVars },
          { name: 'Mustache Keys', vars: Object.keys(baseVars).reduce((acc, k) => ({ ...acc, [`{{${k}}}`]: baseVars[k] }), {}) }
        ];

        let messageData;
        let lastError;

        for (const attempt of attempts) {
          try {
            console.log(`📱 Testing Analytics Strategy: ${attempt.name}`);
            messageData = await this.client.messages.create({
              from: `whatsapp:${this.twilioPhoneNumber}`,
              to: `whatsapp:${customerPhone}`,
              contentSid: templateSid.trim(),
              contentVariables: JSON.stringify(attempt.vars)
            });
            
            console.log(`✅ Analytics Strategy ${attempt.name} accepted. SID: ${messageData.sid}`);
            return { success: true, messageId: messageData.sid, strategy: attempt.name };
          } catch (err) {
            console.error(`❌ Analytics Strategy ${attempt.name} Error:`, err.code, err.message);
            lastError = err;
          }
        }

        throw lastError || new Error('All analytics template strategies failed');
      }

      // Fallback for non-template (sandbox or open window)
      let message = "";
      
      if (isOTPRequest) {
        message = `
🔐 *VERIFICATION CODE*

Hello! Your verification code for *${tenantName}* analytics is below.

*Form:* ${formTitle}
*Email:* ${email}
*Code:* *${otp}*

Note: This code will expire in 5 minutes.

Click below to verify:
${inviteLink}
        `.trim();
      } else {
        message = `
📊 *ANALYTICS DASHBOARD INVITE*

Hello! You have been invited by *${tenantName}* to view the analytics for the following form:

*Form Name:*
*${formTitle}*

${customMessage ? `_"${customMessage}"_\n` : ""}
${includeLink ? `Click the link below to view the dashboard:\n${inviteLink}` : "Please check your email for the detailed PDF report."}

Thank you!
        `.trim();
      }

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${customerPhone}`,
        body: message,
      });

      console.log('Analytics invite sent via WhatsApp:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending analytics invite via WhatsApp:', error);
      return { success: false, error: error.message };
    }
  }

  async sendStatusUpdate(serviceRequest, customerInfo, status, message, estimatedCompletion = null) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const customerPhone = this.formatPhoneNumber(customerInfo.phone);
      if (!customerPhone) {
        return { success: false, error: 'Invalid customer phone number' };
      }

      const statusEmojis = {
        'received': '📥',
        'in-progress': '⚙️',
        'waiting-parts': '⏳',
        'completed': '✅',
        'ready-pickup': '🚗'
      };

      const emoji = statusEmojis[status] || '📌';
      const statusText = status.replace('-', ' ').toUpperCase();

      const whatsappMessage = `
${emoji} *SERVICE STATUS UPDATE*

Dear ${customerInfo.name},

*Vehicle:* ${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel}
*Status:* ${statusText}

*Update:*
${message}

${estimatedCompletion ? `⏰ *Estimated Completion:* ${estimatedCompletion}` : ''}

*Questions?*
Call: (555) 123-4567
Reference your request ID
      `.trim();

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${customerPhone}`,
        body: whatsappMessage,
      });

      console.log('Status update sent:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending status update:', error);
      return { success: false, error: error.message };
    }
  }

  async sendResponseReport(recipientPhone, subject, fileData, fileName) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const phone = this.formatPhoneNumber(recipientPhone);
      if (!phone) {
        return { success: false, error: 'Invalid phone number' };
      }

      console.log('📱 Attempting to send report via WhatsApp...');
      console.log('To:', phone);
      console.log('Subject:', subject);

      const message = `
📊 *RESPONSE REPORT*

Hello! Please find the latest dashboard data and response details summary below.

*Report Contents:*
📈 *Sheet 1 — Dashboard:* Summary statistics, percentages, and weighted data
📋 *Sheet 2 — Responses:* Detailed responses organized by sections

_Please check your email for the attached Excel file with complete details._

Report Generated: ${new Date().toLocaleString()}
      `.trim();

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${phone}`,
        body: message,
      });

      console.log('✅ Response report notification sent via WhatsApp!');
      console.log('Message ID:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('❌ Error sending response report:');
      console.error('Error message:', error.message);
      return { success: false, error: error.message };
    }
  }

  async testConnection() {
    try {
      if (!this.isConfigured) {
        return { 
          success: false, 
          error: 'Twilio WhatsApp service not configured. Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN' 
        };
      }

      if (!this.twilioPhoneNumber) {
        return { 
          success: false, 
          error: 'TWILIO_WHATSAPP_NUMBER environment variable not set' 
        };
      }

      await this.client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      console.log('✅ Twilio WhatsApp connection successful');
      return { success: true, message: 'Twilio WhatsApp connection successful' };
    } catch (error) {
      console.error('❌ Twilio WhatsApp connection failed:', error);
      return { success: false, error: error.message };
    }
  }

  async sendTestMessage(recipientPhone) {
    try {
      if (!this.isConfigured) {
        return { success: false, error: 'Twilio WhatsApp service not configured' };
      }

      const phone = this.formatPhoneNumber(recipientPhone);
      if (!phone) {
        return { success: false, error: 'Invalid phone number format' };
      }

      const message = `
✅ *TEST MESSAGE*

This is a test message from Focus Auto Shop WhatsApp integration.

If you received this, WhatsApp service is working correctly! 🎉

Configuration Status:
✓ Twilio Account Connected
✓ WhatsApp Service Active
✓ Message Delivery Working

Timestamp: ${new Date().toLocaleString()}
      `.trim();

      const messageData = await this.client.messages.create({
        from: `whatsapp:${this.twilioPhoneNumber}`,
        to: `whatsapp:${phone}`,
        body: message,
      });

      console.log('Test message sent:', messageData.sid);
      return { success: true, messageId: messageData.sid };
    } catch (error) {
      console.error('Error sending test message:', error);
      return { success: false, error: error.message };
    }
  }
}

export default new WhatsAppService();
