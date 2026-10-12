import nodemailer from 'nodemailer';
import { MailerSend, EmailParams, Sender, Recipient, Attachment } from 'mailersend';

class MailService {
  constructor() {
    this.useMailerSend = !!process.env.MAILERSEND_API_KEY;

    if (this.useMailerSend) {
      console.log('📧 Initializing MailerSend...');
      this.mailersend = new MailerSend({
        apiKey: process.env.MAILERSEND_API_KEY,
      });
    }

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const isGmail   = host.includes('gmail.com');
    const isOutlook = host.includes('outlook.com') || host.includes('office365.com');

    // ─── Transport configs ────────────────────────────────────────────────────

    let transportConfig;

    if (isGmail) {
      transportConfig = {
        service: 'gmail',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      };
    } else if (isOutlook) {
      // Office 365 requires STARTTLS on port 587, authMethod LOGIN, and NO pooling
      transportConfig = {
        host: 'smtp.office365.com',
        port: 587,
        secure: false,          // STARTTLS — NOT SSL
        requireTLS: true,       // Force STARTTLS upgrade
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        authMethod: 'LOGIN',    // O365 requires LOGIN, not PLAIN
        tls: {
          rejectUnauthorized: false,
          servername: 'smtp.office365.com',
          minVersion: 'TLSv1.2',
        },
      };
    } else {
      transportConfig = {
        host,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        tls: {
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
        },
      };
    }

    // ─── Pool: DISABLED for Office 365 (it drops idle pooled connections) ────
    // Pool is only beneficial for high-volume Gmail / generic SMTP setups.
    const usePool = !isOutlook;

    this.fromAddress = `"${process.env.SMTP_SENDER_NAME || '3W-WHEELER'}" <${process.env.SMTP_USER}>`;

    this.transporter = nodemailer.createTransport({
      ...transportConfig,

      // Pooling — off for Outlook to prevent idle-drop failures
      pool:           usePool,
      maxConnections: usePool ? 5   : undefined,
      maxMessages:    usePool ? 100 : undefined,
      rateDelta:      usePool ? 1000 : undefined,
      rateLimit:      usePool ? 5   : undefined,

      // Timeouts
      connectionTimeout: 30_000,
      greetingTimeout:   30_000,
      socketTimeout:     45_000,
      dnsTimeout:        10_000,

      debug:  process.env.NODE_ENV !== 'production', // avoid verbose logs in prod
      logger: process.env.NODE_ENV !== 'production',
    });

    console.log('📧 MailService initialized:', {
      mode:    this.useMailerSend ? 'MailerSend' : 'SMTP',
      host:    isGmail ? 'gmail (service)' : transportConfig.host,
      user:    process.env.SMTP_USER,
      pool:    usePool,
      outlook: isOutlook,
    });
  }

  // ─── Shared base HTML wrapper ─────────────────────────────────────────────

  _baseWrapper(headerTitle, headerColor = '#2563eb', accentColor = '#f5c518', bodyContent) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
        <div style="background-color: ${headerColor}; padding: 24px 32px;">
          <h1 style="color: #ffffff; margin: 0; font-size: 18px; font-weight: bold; letter-spacing: 0.5px; text-transform: uppercase;">
            ${headerTitle}
          </h1>
        </div>
        <div style="padding: 32px;">
          <div style="height: 4px; background-color: ${accentColor}; margin-bottom: 28px; border-radius: 2px;"></div>
          ${bodyContent}
          <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
              Focus Auto Shop — Automated Notification<br>
              <span style="font-size: 11px;">Generated: ${new Date().toLocaleString()}</span>
            </p>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Internal SMTP send (with safe error logging) ─────────────────────────

  async _sendViaSMTP(mailOptions) {
    const result = await this.transporter.sendMail(mailOptions);
    // Never log the full subject/body — it may contain OTPs or sensitive data
    console.log('✅ Email sent via SMTP. MessageId:', result.messageId, '| To:', mailOptions.to, mailOptions.cc ? `| CC: ${mailOptions.cc}` : '');
    return { success: true, messageId: result.messageId };
  }

  // ─── Test connection ──────────────────────────────────────────────────────

  async testConnection() {
    try {
      console.log('📧 Testing SMTP connection...', {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
      });
      await this.transporter.verify();
      console.log('✅ SMTP connection verified successfully');
      return { success: true, message: 'Mail server connection successful' };
    } catch (error) {
      console.error('❌ SMTP connection failed:', {
        message: error.message,
        code:    error.code,
        command: error.command,
      });
      return { success: false, error: error.message, code: error.code };
    }
  }

  // ─── New service request → notify shop ───────────────────────────────────

  async sendServiceRequestNotification(serviceRequest, customerInfo) {
    try {
      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello, <strong>FOCUS AUTO SHOP TEAM,</strong></p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 28px;">
          A new service request was submitted on <strong>${new Date().toLocaleDateString()}</strong>.
        </p>

        <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #6b7280; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">Customer Information</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Name:</strong> ${customerInfo.name}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Email:</strong> ${customerInfo.email}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Phone:</strong> ${customerInfo.phone || 'Not provided'}</p>
        </div>

        <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #92400e; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">Vehicle Information</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Make:</strong> ${serviceRequest.vehicleMake}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Model:</strong> ${serviceRequest.vehicleModel}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Year:</strong> ${serviceRequest.vehicleYear || 'Not specified'}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>License Plate:</strong> ${serviceRequest.licensePlate || 'Not provided'}</p>
        </div>

        <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #991b1b; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">Service Details</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Service Type:</strong> ${serviceRequest.serviceType}</p>
          ${serviceRequest.urgency       ? `<p style="margin: 4px 0; color: #dc2626;"><strong>Urgency:</strong> ${serviceRequest.urgency}</p>` : ''}
          ${serviceRequest.preferredDate ? `<p style="margin: 4px 0; color: #111827;"><strong>Preferred Date:</strong> ${serviceRequest.preferredDate}</p>` : ''}
          <p style="margin: 12px 0 4px; color: #111827;"><strong>Issue Description:</strong></p>
          <p style="background: #fff; border: 1px solid #fecaca; padding: 12px; border-radius: 6px; color: #374151; margin: 0;">${serviceRequest.issueDescription}</p>
        </div>

        <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px 20px; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; color: #1e40af; font-size: 14px;">
            📋 <strong>Request ID:</strong> ${serviceRequest.id || 'N/A'} &nbsp;|&nbsp;
            🕒 <strong>Submitted:</strong> ${new Date().toLocaleString()}
          </p>
        </div>
      `;

      return await this._sendViaSMTP({
        from:    this.fromAddress,
        to:      process.env.SHOP_EMAIL || 'admin@focus.com',
        subject: `🚗 New Service Request — ${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel}`,
        html:    this._baseWrapper('New Service Request Received', '#2563eb', '#f5c518', body),
      });
    } catch (error) {
      console.error('❌ sendServiceRequestNotification failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Confirmation email → customer ────────────────────────────────────────

  async sendCustomerConfirmation(serviceRequest, customerInfo) {
    try {
      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello, <strong>${customerInfo.name.toUpperCase()},</strong></p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 28px;">
          Thank you for choosing <strong>Focus Auto Shop</strong>. We have received your service request and will be in touch shortly.
        </p>

        <div style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
          <p style="font-size: 13px; font-weight: bold; color: #166534; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">Your Request Summary</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Vehicle:</strong> ${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel} ${serviceRequest.vehicleYear || ''}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Service Type:</strong> ${serviceRequest.serviceType}</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Issue:</strong> ${serviceRequest.issueDescription}</p>
          ${serviceRequest.preferredDate ? `<p style="margin: 4px 0; color: #111827;"><strong>Preferred Date:</strong> ${serviceRequest.preferredDate}</p>` : ''}
        </div>

        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
          <p style="font-size: 13px; font-weight: bold; color: #1e40af; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">What Happens Next?</p>
          <p style="margin: 6px 0; color: #374151;">✅ Our team will review your request within 24 hours</p>
          <p style="margin: 6px 0; color: #374151;">📅 We'll contact you to confirm your appointment</p>
          <p style="margin: 6px 0; color: #374151;">🔧 Our certified mechanics will diagnose and fix your vehicle</p>
        </div>

        <div style="text-align: center; background: #f9fafb; border-radius: 8px; padding: 20px;">
          <p style="font-weight: bold; color: #111827; margin: 0 0 6px;">Need immediate assistance?</p>
          <p style="color: #2563eb; font-size: 18px; font-weight: bold; margin: 0 0 4px;">📞 (555) 123-4567</p>
          <p style="color: #6b7280; font-size: 13px; margin: 0;">support@focus-auto.com</p>
        </div>
      `;

      return await this._sendViaSMTP({
        from:    this.fromAddress,
        to:      customerInfo.email,
        subject: `✅ Service Request Received — Focus Auto Shop`,
        html:    this._baseWrapper('Service Request Confirmed', '#16a34a', '#f5c518', body),
      });
    } catch (error) {
      console.error('❌ sendCustomerConfirmation failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Status update → customer ─────────────────────────────────────────────

  async sendStatusUpdate(serviceRequest, customerInfo, status, message, estimatedCompletion = null) {
    try {
      const statusMap = {
        'received':      { color: '#3b82f6', label: 'Received',          accent: '#bfdbfe' },
        'in-progress':   { color: '#f59e0b', label: 'In Progress',       accent: '#fde68a' },
        'waiting-parts': { color: '#ef4444', label: 'Waiting for Parts', accent: '#fecaca' },
        'completed':     { color: '#10b981', label: 'Completed',         accent: '#a7f3d0' },
        'ready-pickup':  { color: '#16a34a', label: 'Ready for Pickup',  accent: '#bbf7d0' },
      };
      const s = statusMap[status] || { color: '#6b7280', label: status, accent: '#e5e7eb' };

      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello, <strong>${customerInfo.name.toUpperCase()},</strong></p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 28px;">
          Here is the latest update on your vehicle at <strong>Focus Auto Shop</strong>.
        </p>

        <div style="background: #f8fafc; border-left: 4px solid ${s.color}; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #6b7280; text-transform: uppercase; margin: 0 0 8px; letter-spacing: 1px;">Vehicle</p>
          <p style="font-size: 17px; color: #111827; font-weight: bold; margin: 0 0 12px;">${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel}</p>
          <p style="font-size: 13px; font-weight: bold; color: #6b7280; text-transform: uppercase; margin: 0 0 6px; letter-spacing: 1px;">Current Status</p>
          <span style="display: inline-block; background: ${s.accent}; color: ${s.color}; font-weight: bold; font-size: 14px; padding: 6px 16px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">
            ${s.label}
          </span>
        </div>

        <div style="background: #ffffff; border: 1px solid #e5e7eb; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #6b7280; text-transform: uppercase; margin: 0 0 10px; letter-spacing: 1px;">Update Details</p>
          <p style="color: #374151; margin: 0;">${message}</p>
          ${estimatedCompletion ? `
            <p style="margin: 14px 0 0; color: #059669; font-weight: bold;">
              🕒 Estimated Completion: ${estimatedCompletion}
            </p>` : ''}
        </div>

        <div style="text-align: center; background: #f9fafb; border-radius: 8px; padding: 20px;">
          <p style="font-weight: bold; color: #111827; margin: 0 0 6px;">Questions about your service?</p>
          <p style="color: #2563eb; font-size: 18px; font-weight: bold; margin: 0 0 4px;">📞 (555) 123-4567</p>
          <p style="color: #6b7280; font-size: 13px; margin: 0;">Please have your Request ID ready when calling</p>
        </div>
      `;

      return await this._sendViaSMTP({
        from:    this.fromAddress,
        to:      customerInfo.email,
        subject: `🔧 Service Update: ${serviceRequest.vehicleMake} ${serviceRequest.vehicleModel} — ${s.label.toUpperCase()}`,
        html:    this._baseWrapper('Service Status Update', s.color, '#f5c518', body),
      });
    } catch (error) {
      console.error('❌ sendStatusUpdate failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Excel report with attachment ─────────────────────────────────────────

  async sendResponseReportWithAttachment(recipientEmail, subject, fileData, fileName) {
    try {
      console.log('📧 Sending report email to:', recipientEmail);

      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello,</p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 28px;">
          Please find the attached Excel report with the latest dashboard data and response details.
        </p>

        <div style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <p style="font-size: 13px; font-weight: bold; color: #166534; text-transform: uppercase; margin: 0 0 12px; letter-spacing: 1px;">Report Contents</p>
          <p style="margin: 6px 0; color: #374151;">📊 <strong>Sheet 1 — Dashboard:</strong> Summary statistics, percentages, and weighted data</p>
          <p style="margin: 6px 0; color: #374151;">📋 <strong>Sheet 2 — Responses:</strong> Detailed responses organised by sections</p>
        </div>

        <div style="text-align: center; background: #f9fafb; border-radius: 8px; padding: 16px;">
          <p style="color: #6b7280; font-size: 13px; margin: 0;">
            📎 Attachment: <strong>${fileName || 'report.xlsx'}</strong>
          </p>
        </div>
      `;

      return await this._sendViaSMTP({
        from:        this.fromAddress,
        to:          recipientEmail,
        subject:     subject || 'Response Report',
        html:        this._baseWrapper('Response Report', '#2563eb', '#f5c518', body),
        attachments: [{ filename: fileName || 'report.xlsx', content: fileData }],
      });
    } catch (error) {
      console.error('❌ sendResponseReportWithAttachment failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Form invitation ──────────────────────────────────────────────────────

  async sendFormInvite(recipientEmail, formTitle, inviteLink, tenantName) {
    try {
      console.log('📧 Sending form invite to:', recipientEmail);

      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello,</p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 20px;">
          You have been invited by <strong>${tenantName}</strong> to fill out the following form:
        </p>

        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 28px;">
          <p style="font-size: 13px; font-weight: bold; color: #1e40af; text-transform: uppercase; margin: 0 0 8px; letter-spacing: 1px;">Form Name</p>
          <p style="font-size: 18px; font-weight: bold; color: #1e40af; margin: 0;">${formTitle}</p>
        </div>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${inviteLink}"
             style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-size: 16px; font-weight: bold; letter-spacing: 0.3px;">
            Fill Out Form →
          </a>
        </div>

        <p style="font-size: 13px; color: #9ca3af; text-align: center; margin: 20px 0 0;">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <a href="${inviteLink}" style="color: #2563eb; word-break: break-all; font-size: 12px;">${inviteLink}</a>
        </p>
      `;

      return await this._sendViaSMTP({
        from:    this.fromAddress,
        to:      recipientEmail,
        subject: `Invitation: Please complete "${formTitle}"`,
        html:    this._baseWrapper('Your Feedback Is Important', '#2563eb', '#f5c518', body),
      });
    } catch (error) {
      console.error('❌ sendFormInvite failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Analytics invite / OTP ───────────────────────────────────────────────

  async sendAnalyticsInvite(
    recipientEmail, formTitle, inviteLink, otp, tenantName,
    customMessage, isOTPRequest = false, pdfAttachment = null, includeLink = true, ccEmails = [], excelAttachment = null
  ) {
    try {
      console.log('📧 Sending analytics invite to:', recipientEmail, '| OTP request:', isOTPRequest, '| Attachments: PDF=', !!pdfAttachment, 'Excel=', !!excelAttachment);

      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello,</p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 20px;">
          ${isOTPRequest
            ? `Your verification code for <strong>${tenantName}</strong> analytics is below.`
            : (pdfAttachment || excelAttachment) && !includeLink
              ? `Please find the inspection responses and analytics report for <strong>${formTitle}</strong> attached to this email.`
              : `You have been invited by <strong>${tenantName}</strong> to view the analytics for the following form:`
          }
        </p>

        ${customMessage && !isOTPRequest ? `
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 16px; border-radius: 8px; margin-bottom: 24px; color: #4b5563; font-style: italic;">
          "${customMessage}"
        </div>
        ` : ''}

        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 28px;">
          <p style="font-size: 13px; font-weight: bold; color: #1e40af; text-transform: uppercase; margin: 0 0 8px; letter-spacing: 1px;">Form Name</p>
          <p style="font-size: 18px; font-weight: bold; color: #1e40af; margin: 0;">${formTitle}</p>
        </div>

        ${isOTPRequest ? `
        <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 20px; border-radius: 0 8px 8px 0; margin-bottom: 28px;">
          <p style="font-size: 13px; font-weight: bold; color: #92400e; text-transform: uppercase; margin: 0 0 8px; letter-spacing: 1px;">Verification Details</p>
          <p style="margin: 4px 0; color: #111827;"><strong>Email:</strong> ${recipientEmail}</p>
          <p style="margin: 8px 0 0; color: #111827;"><strong>Verification Code:</strong></p>
          <p style="font-size: 28px; font-weight: bold; color: #b45309; letter-spacing: 4px; margin: 6px 0;">${otp}</p>
          <p style="font-size: 12px; color: #92400e; margin-top: 8px;">⚠️ This code expires in 5 minutes.</p>
        </div>
        ` : includeLink ? `
        <div style="text-align: center; margin: 28px 0;">
          <a href="${inviteLink}"
             style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">
            View Analytics Dashboard
          </a>
        </div>
        <p style="font-size: 13px; color: #9ca3af; text-align: center;">
          If the button doesn't work, paste this link into your browser:<br>
          <a href="${inviteLink}" style="color: #2563eb; word-break: break-all; font-size: 12px;">${inviteLink}</a>
        </p>
        ` : ''}

        ${!isOTPRequest ? `
        <p style="font-size: 13px; color: #6b7280;">
          If you did not expect this invitation, you can safely ignore this email.
        </p>` : ''}

        ${pdfAttachment ? `
        <div style="margin-top: 16px; padding: 14px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; text-align: center;">
          <p style="font-size: 14px; color: #166534; margin: 0;">
            📄 A PDF analytics report has been attached to this email.
          </p>
        </div>
        ` : ''}

        ${excelAttachment ? `
        <div style="margin-top: 16px; padding: 14px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; text-align: center;">
          <p style="font-size: 14px; color: #047857; margin: 0; font-weight: bold;">
            📊 Inspection Responses Tab (.xlsx) has been attached to this email.
          </p>
        </div>
        ` : ''}
      `;

      // Subject: never include the raw OTP in the subject line (shows in logs)
      const subject = isOTPRequest
        ? `Your Verification Code — ${tenantName}`
        : `📊 Inspection Responses & Analytics — ${formTitle}`;

      const html = this._baseWrapper(
        isOTPRequest ? 'Email Verification' : 'Inspection Responses & Analytics',
        '#2563eb', '#f5c518', body
      );

      // ── Try MailerSend first ──────────────────────────────────────────────
      if (this.useMailerSend) {
        try {
          console.log('🚀 Attempting send via MailerSend...');

          const sentFrom   = new Sender(
            process.env.MAILERSEND_FROM_EMAIL || 'no-reply@evsuae.com',
            process.env.SMTP_SENDER_NAME || 'EVSUAE'
          );
          const recipients = [new Recipient(recipientEmail, recipientEmail.split('@')[0])];

          const attachments = [];
          if (pdfAttachment) {
            attachments.push(new Attachment(
              pdfAttachment.content.toString('base64'),
              pdfAttachment.filename || 'Analytics_Report.pdf',
              'attachment'
            ));
          }
          if (excelAttachment) {
            attachments.push(new Attachment(
              excelAttachment.content.toString('base64'),
              excelAttachment.filename || `${formTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_Responses.xlsx`,
              'attachment'
            ));
          }

          const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject(subject)
            .setHtml(html)
            .setAttachments(attachments);

          if (ccEmails && ccEmails.length > 0) {
            const ccRecips = ccEmails.map(email => new Recipient(email, email.split('@')[0]));
            emailParams.setCc(ccRecips);
          }

          await this.mailersend.email.send(emailParams);
          console.log('✅ Sent via MailerSend to:', recipientEmail);
          return { success: true };
        } catch (msError) {
          console.error('❌ MailerSend failed:', msError.body || msError.message);
          if (!process.env.SMTP_USER) {
            return { success: false, error: `MailerSend failed: ${msError.message}` };
          }
          console.log('🔄 Falling back to SMTP...');
        }
      }

      // ── SMTP fallback ─────────────────────────────────────────────────────
      const smtpAttachments = [];
      if (pdfAttachment) {
        smtpAttachments.push({
          filename:    pdfAttachment.filename || 'Analytics_Report.pdf',
          content:     pdfAttachment.content,
          contentType: 'application/pdf',
        });
      }
      if (excelAttachment) {
        smtpAttachments.push({
          filename:    excelAttachment.filename || `${formTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_Responses.xlsx`,
          content:     excelAttachment.content,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }

      return await this._sendViaSMTP({
        from:        this.fromAddress,
        to:          recipientEmail,
        cc:          ccEmails && ccEmails.length > 0 ? ccEmails.join(',') : undefined,
        subject,
        html,
        attachments: smtpAttachments,
      });
    } catch (error) {
      console.error('❌ sendAnalyticsInvite failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Generic OTP email ────────────────────────────────────────────────────

  async sendOTP(recipientEmail, otp) {
    try {
      console.log('📧 Sending OTP email to:', recipientEmail);
      // ⚠️  Never log the OTP value itself

      const body = `
        <p style="font-size: 16px; color: #111827; margin: 0 0 6px;">Hello,</p>
        <p style="font-size: 15px; color: #374151; margin: 0 0 20px;">
          Your verification code is:
        </p>

        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 24px 20px; border-radius: 0 8px 8px 0; margin-bottom: 28px; text-align: center;">
          <span style="font-size: 32px; font-weight: bold; color: #2563eb; letter-spacing: 6px;">${otp}</span>
        </div>

        <p style="font-size: 14px; color: #6b7280; line-height: 1.5;">
          This code will expire in <strong>5 minutes</strong>. If you did not request this, please ignore this email.
        </p>
      `;

      // Subject: do NOT put the OTP in the subject — it gets written to SMTP logs
      return await this._sendViaSMTP({
        from:    this.fromAddress,
        to:      recipientEmail,
        subject: 'Your Verification Code',
        html:    this._baseWrapper('Verify Your Email', '#2563eb', '#f5c518', body),
      });
    } catch (error) {
      console.error('❌ sendOTP failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

export default new MailService();