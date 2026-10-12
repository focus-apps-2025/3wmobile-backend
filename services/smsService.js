import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

class SMSService {
    constructor() {
        this.accountSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;
        this.smsNumber = process.env.TWILIO_SMS_NUMBER;

        this.isConfigured = !!(this.accountSid && this.authToken && this.smsNumber);

        if (this.isConfigured) {
            this.client = twilio(this.accountSid, this.authToken);
            console.log('✅ SMS Service initialized');
            console.log(`   SMS Number: ${this.smsNumber}`);
        } else {
            console.log('⚠️  SMS Service not configured - missing credentials');
        }
    }

    formatPhoneNumber(phone) {
        if (!phone) return null;

        // Remove all non-digit characters
        let cleaned = phone.replace(/\D/g, '');

        // If it starts with 91 (India) and has 12 digits, add +
        if (cleaned.startsWith('91') && cleaned.length === 12) {
            return `+${cleaned}`;
        }

        // If it starts with 1 (US) and has 11 digits, add +
        if (cleaned.startsWith('1') && cleaned.length === 11) {
            return `+${cleaned}`;
        }

        // If it has 10 digits, assume India and add +91
        if (cleaned.length === 10) {
            return `+91${cleaned}`;
        }

        // If it already starts with +, return as is
        if (phone.startsWith('+')) {
            return phone;
        }

        // Otherwise, add + and return
        return `+${cleaned}`;
    }

    async sendOTP(phone, otp) {
        try {
            console.log(`[SMS] sendOTP called for phone: ${phone}`);
            if (!this.isConfigured) {
                console.warn('[SMS] Twilio not configured - returning success for development');
                // For development, we might want to still proceed as if it was sent
                return { success: true, message: 'SMS service not configured (Dev Mode)', otp };
            }

            const customerPhone = this.formatPhoneNumber(phone);
            if (!customerPhone) {
                return { success: false, error: 'Invalid phone number' };
            }

            const message = `Your 3W-WHEELER Forms verification code is: ${otp}. Valid for 5 minutes.`;

            const result = await this.client.messages.create({
                from: this.smsNumber,
                to: customerPhone,
                body: message
            });

            console.log('✅ [SMS] OTP sent success:', result.sid);
            return {
                success: true,
                messageSid: result.sid
            };

        } catch (error) {
            console.error('❌ Failed to send OTP SMS:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async sendFormInvite(phone, formTitle, inviteLink, tenantName) {
        try {
            console.log(`[SMS] sendFormInvite called for phone: ${phone}`);
            if (!this.isConfigured) {
                console.error('[SMS] Twilio not configured');
                return { success: false, error: 'Twilio SMS service not configured' };
            }

            const customerPhone = this.formatPhoneNumber(phone);
            console.log(`[SMS] Formatted phone: ${customerPhone}`);
            
            if (!customerPhone) {
                console.error(`[SMS] Invalid phone: ${phone}`);
                return { success: false, error: 'Invalid phone number' };
            }

            // SMS message (160 characters limit for single SMS, 1600 for concatenated)
            // Keep it concise to avoid multiple SMS charges
            const message = `Hello! ${tenantName} would like your feedback on your recent service. Please share your experience here: ${inviteLink}`;

            console.log(`📱 [SMS] Sending to: ${customerPhone}`);
            console.log(`💬 [SMS] Message: ${message}`);

            const result = await this.client.messages.create({
                from: this.smsNumber,
                to: customerPhone,
                body: message
            });

            console.log('✅ [SMS] Twilio response success:', result.sid);

            return {
                success: true,
                messageSid: result.sid,
                status: result.status,
                to: customerPhone
            };

        } catch (error) {
            console.error('❌ Failed to send SMS:', error);
            return {
                success: false,
                error: error.message,
                code: error.code
            };
        }
    }
    

    async checkMessageStatus(messageSid) {
        try {
            if (!this.isConfigured) {
                return { success: false, error: 'Twilio SMS service not configured' };
            }

            const message = await this.client.messages(messageSid).fetch();

            return {
                success: true,
                status: message.status,
                to: message.to,
                from: message.from,
                dateSent: message.dateSent,
                price: message.price,
                priceUnit: message.priceUnit,
                errorCode: message.errorCode,
                errorMessage: message.errorMessage
            };

        } catch (error) {
            console.error('❌ Failed to check SMS status:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
const smsService = new SMSService();
export default smsService;