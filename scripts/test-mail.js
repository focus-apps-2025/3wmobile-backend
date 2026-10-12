import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env before importing mailService
dotenv.config({ path: path.join(__dirname, '../.env') });

// Use dynamic import or ensure this comes after config
const { default: mailService } = await import('../services/mailService.js');

async function runTest() {
  console.log('🚀 Starting mail service connection test...');
  
  if (process.env.MAILERSEND_API_KEY) {
    console.log('📬 Testing MailerSend configuration...');
    console.log('   API Key found (starts with):', process.env.MAILERSEND_API_KEY.substring(0, 10) + '...');
    console.log('   From Email:', process.env.MAILERSEND_FROM_EMAIL);
  }

  const result = await mailService.testConnection();
  
  if (result.success) {
    console.log('✅ Success! SMTP/Mail configuration is correct.');
  } else {
    console.error('❌ Failed! Problem with SMTP configuration.');
    console.error('Error details:', result);
    
    if (result.code === 'EAUTH') {
      console.log('\n💡 Hint: This is an authentication error. Please check:');
      console.log('1. Is the SMTP_USER correct? (' + process.env.SMTP_USER + ')');
      console.log('2. Is the SMTP_PASS correct? (App Password should be 16 characters, no spaces)');
      console.log('3. Is MFA enabled on the account? (Required for App Passwords)');
    } else if (result.code === 'ESOCKET' || result.code === 'ETIMEDOUT') {
      console.log('\n💡 Hint: This is a connection timeout. Please check:');
      console.log('1. Is the SMTP_HOST correct? (' + process.env.SMTP_HOST + ')');
      console.log('2. Is port 587 open on your network?');
    }
  }
}

runTest();
