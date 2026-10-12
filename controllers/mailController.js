import MailService from '../services/mailService.js';

export const sendServiceRequestNotification = async (req, res) => {
  try {
    const { serviceRequest, customerInfo } = req.body;

    if (!serviceRequest || !customerInfo) {
      return res.status(400).json({
        success: false,
        message: 'Service request and customer information are required'
      });
    }

    // Send notification to shop
    const shopNotification = await MailService.sendServiceRequestNotification(serviceRequest, customerInfo);
    
    // Send confirmation to customer
    const customerConfirmation = await MailService.sendCustomerConfirmation(serviceRequest, customerInfo);

    res.json({
      success: true,
      message: 'Notifications sent successfully',
      data: {
        shopNotification,
        customerConfirmation
      }
    });

  } catch (error) {
    console.error('Error in sendServiceRequestNotification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send notifications',
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

    const result = await MailService.sendStatusUpdate(
      serviceRequest, 
      customerInfo, 
      status, 
      message, 
      estimatedCompletion
    );

    res.json({
      success: true,
      message: 'Status update sent successfully',
      data: result
    });

  } catch (error) {
    console.error('Error in sendStatusUpdate:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send status update',
      error: error.message
    });
  }
};

export const testMailConnection = async (req, res) => {
  try {
    const result = await MailService.testConnection();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Mail service is working correctly',
        data: result
      });
    } else {
      let advice = "Please check your SMTP credentials in .env.";
      if (result.error?.includes('BadCredentials') || result.error?.includes('Invalid login')) {
        advice = "Gmail rejected your credentials. Ensure you are using a 16-character App Password (with no spaces) and that 2FA is enabled on your Google account.";
      }

      res.status(500).json({
        success: false,
        message: result.message || 'Mail service connection failed',
        error: result.error,
        advice
      });
    }

  } catch (error) {
    console.error('Error testing mail connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test mail connection',
      error: error.message
    });
  }
};

// Send a test email
export const sendTestEmail = async (req, res) => {
  try {
    const { to } = req.body;
    
    if (!to) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email is required'
      });
    }

    const testServiceRequest = {
      vehicleMake: 'Toyota',
      vehicleModel: 'Camry',
      vehicleYear: '2020',
      serviceType: 'Oil Change',
      issueDescription: 'Regular maintenance - oil change and inspection',
      urgency: 'Normal',
      preferredDate: new Date().toLocaleDateString(),
      id: 'TEST-' + Date.now()
    };

    const testCustomerInfo = {
      name: 'Test Customer',
      email: to,
      phone: '(555) 123-4567'
    };

    const result = await MailService.sendServiceRequestNotification(testServiceRequest, testCustomerInfo);
    
    res.json({
      success: true,
      message: 'Test email sent successfully',
      data: result
    });

  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test email',
      error: error.message
    });
  }
};

export const sendResponseReport = async (req, res) => {
  try {
    console.log('📨 sendResponseReport called');
    console.log('User:', req.user?.email, 'Role:', req.user?.role);
    console.log('req.body:', req.body);
    console.log('req.files:', req.files ? Object.keys(req.files) : 'NO FILES');
    
    const { email, subject } = req.body;
    const file = req.files?.file;

    console.log('Email:', email);
    console.log('Subject:', subject);
    console.log('File:', file ? `${file.name} (${file.size} bytes)` : 'NO FILE');

    if (!email) {
      console.error('❌ Missing email');
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    if (!subject) {
      console.error('❌ Missing subject');
      return res.status(400).json({
        success: false,
        message: 'Subject is required'
      });
    }

    if (!file) {
      console.error('❌ No file received');
      return res.status(400).json({
        success: false,
        message: 'Excel file is required',
        receivedFields: Object.keys(req.body)
      });
    }

    const fileData = file.data || file;
    const fileName = file.name || 'report.xlsx';

    console.log('Validating email format...');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address format'
      });
    }

    console.log('Sending email...');
    const result = await MailService.sendResponseReportWithAttachment(
      email,
      subject,
      fileData,
      fileName
    );

    if (!result.success) {
      console.error('❌ MailService returned error:', result.error);
      return res.status(500).json({
        success: false,
        message: 'Failed to send email',
        error: result.error
      });
    }

    console.log('✅ Report sent successfully');
    res.json({
      success: true,
      message: 'Report sent successfully',
      data: result
    });

  } catch (error) {
    console.error('❌ Error in sendResponseReport:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send report',
      error: error.message
    });
  }
};

export const testResponseReportEmail = async (req, res) => {
  try {
    const { to } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email is required'
      });
    }

    const testBuffer = Buffer.from('Test Report Data');
    
    const result = await MailService.sendResponseReportWithAttachment(
      to,
      'Test Report - Response Report System',
      testBuffer,
      'test-report.xlsx'
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Test email sent successfully!',
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email',
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error in testResponseReportEmail:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test email',
      error: error.message
    });
  }
};