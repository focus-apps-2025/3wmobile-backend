# WhatsApp Integration Setup Guide

## Overview
Complete WhatsApp service implementation using Twilio, mirroring the email system structure.

## Files Created

### Backend Services
- **`services/whatsappService.js`** - Twilio WhatsApp service with methods:
  - `sendServiceRequestNotification()` - Notify shop + customer
  - `sendCustomerConfirmation()` - Confirmation to customer
  - `sendStatusUpdate()` - Real-time service status updates
  - `sendResponseReport()` - Report notifications
  - `testConnection()` - Verify Twilio connection
  - `sendTestMessage()` - Send test WhatsApp message

### Backend Controllers & Routes
- **`controllers/whatsappController.js`** - Request handlers for all endpoints
- **`routes/whatsappRoutes.js`** - Route definitions (mirrors mail routes)

### Frontend
- **`src/api/client.ts`** - Added 6 new WhatsApp API methods:
  - `testWhatsAppConnection()`
  - `sendTestWhatsAppMessage(phone)`
  - `sendWhatsAppServiceRequestNotification(serviceRequest, customerInfo)`
  - `sendWhatsAppStatusUpdate(serviceRequest, customerInfo, status, message, estimatedCompletion)`
  - `sendWhatsAppResponseReport(phone, subject)`
  - `testWhatsAppResponseReport(phone)`

- **`src/components/WhatsAppTest.tsx`** - Full UI test component with:
  - Demo message templates
  - Connection testing
  - Configuration info

### Configuration
- **`package.json`** - Added `twilio: ^4.10.0` dependency
- **`server.js`** - Registered WhatsApp routes at `/api/whatsapp`

## API Endpoints

### Public Endpoints
- `POST /api/whatsapp/service-request-notification` - Send service request notifications

### Protected Endpoints (Admin only)
- `GET /api/whatsapp/test-connection` - Test Twilio connection
- `POST /api/whatsapp/test-message` - Send test message
- `POST /api/whatsapp/status-update` - Send status updates
- `POST /api/whatsapp/send-response-report` - Send report notifications
- `POST /api/whatsapp/test-response-report` - Test report notification

## Environment Variables Required

Add these to your backend `.env` file:

```
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_NUMBER=+1234567890
TWILIO_SHOP_WHATSAPP=+1234567890
```

## Setup Steps

### 1. Install Twilio Package
```bash
cd backend
npm install
```

### 2. Create Twilio Account
- Visit [twilio.com](https://www.twilio.com)
- Sign up for an account
- Navigate to Console Dashboard

### 3. Get Credentials
- Copy **Account SID** from Dashboard
- Copy **Auth Token** from Dashboard
- Get a WhatsApp-enabled phone number (Sandbox or Production)

### 4. Configure WhatsApp Sandbox (for testing)
- Go to Twilio Console → Messaging → WhatsApp
- Copy the Sandbox Number provided
- Send "join [code]" to that number on WhatsApp to join sandbox

### 5. Add to .env
```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_NUMBER=+1234567890
TWILIO_SHOP_WHATSAPP=+1234567890
```

### 6. Restart Backend
```bash
npm run dev
```

### 7. Test in UI
- Navigate to WhatsApp Test component
- Enter phone number with country code (e.g., +1-555-123-4567 or +919876543210)
- Send test message to verify setup

## Features Included

✅ **Service Request Notifications** - Automatic notifications when customer submits service request
✅ **Customer Confirmations** - Confirmation message to customer
✅ **Status Updates** - Real-time service status with emojis
✅ **Report Notifications** - Send Excel report notifications via WhatsApp
✅ **Phone Formatting** - Automatic phone number normalization
✅ **Error Handling** - Comprehensive error messages and logging
✅ **Production Ready** - Fully authenticated routes, proper error handling, logging
✅ **Test UI** - Complete testing interface matching email system

## Message Examples

### Service Request Notification
```
🚗 *NEW SERVICE REQUEST*

*Customer Information:*
Name: John Doe
Email: john@example.com
Phone: (555) 123-4567

*Vehicle Information:*
Make: Toyota
Model: Corolla
...
```

### Status Update
```
✅ *SERVICE STATUS UPDATE*

Dear John Doe,

*Vehicle:* Toyota Corolla
*Status:* COMPLETED

*Update:*
Great news! Your Toyota Corolla service is complete...
```

## Same Structure as Email System

The WhatsApp implementation follows the exact same architecture as the email system:

| Component | Email | WhatsApp |
|-----------|-------|----------|
| Service | `mailService.js` | `whatsappService.js` |
| Controller | `mailController.js` | `whatsappController.js` |
| Routes | `mailRoutes.js` | `whatsappRoutes.js` |
| API Client Methods | 4 methods | 6 methods |
| Test Component | `MailTest.tsx` | `WhatsAppTest.tsx` |

## Troubleshooting

### Connection Test Fails
- Check Twilio credentials are correct
- Verify Account SID and Auth Token in .env
- Ensure TWILIO_WHATSAPP_NUMBER is set

### Messages Not Sending
- Verify phone numbers have correct format with country code
- For Sandbox: ensure number joined sandbox first
- Check Twilio account has sufficient balance
- Enable WhatsApp in Twilio settings

### Phone Number Formatting Issues
- Service automatically formats numbers
- Accepts formats: `+1234567890`, `1-555-123-4567`, `555123456`
- Always include country code for best results

## Production Deployment

For production:
1. Set up Production WhatsApp Number in Twilio
2. Update `TWILIO_WHATSAPP_NUMBER` to production number
3. Update `TWILIO_SHOP_WHATSAPP` to your shop's number
4. Use verified credentials
5. Test thoroughly in staging environment
6. Deploy backend with updated .env
7. Monitor Twilio logs for delivery status

## Support

For issues with Twilio:
- Visit [Twilio Docs](https://www.twilio.com/docs/whatsapp)
- Check Twilio Account Activity
- Review Message Logs in Twilio Console
