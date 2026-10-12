import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';

async function testUpload() {
  try {
    const tempFile = 'temp-test-image.jpg';
    // Create a tiny dummy file to simulate an image upload
    fs.writeFileSync(tempFile, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]));

    const form = new FormData();
    form.append('file', fs.createReadStream(tempFile), {
      filename: tempFile,
      contentType: 'image/jpeg'
    });

    const url = 'http://192.168.31.205:5000/api/files/upload';
    console.log(`📤 Sending mock upload to ${url}...`);
    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      headers: {
        'X-App-Type': 'mobile-app',
        ...form.getHeaders()
      }
    });

    const duration = Date.now() - start;
    console.log(`Status: ${response.status} (took ${duration}ms)`);
    const text = await response.text();
    try {
      console.log('✅ Response:', JSON.parse(text));
    } catch {
      console.log('✅ Response (Raw):', text);
    }
    
    // Clean up
    fs.unlinkSync(tempFile);
  } catch (error) {
    console.error('❌ Upload failed:', error);
  }
}

testUpload();
