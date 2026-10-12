import fetch from 'node-fetch';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

const testUserFlow = async () => {
  const ip = '192.168.31.205';
  const loginUrl = `http://${ip}:5000/api/auth/login`;
  
  console.log('1. Logging in...');
  const loginRes = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Type': 'mobile-app'
    },
    body: JSON.stringify({ email: 'vicky@gmail.com', password: '123456' })
  });

  const loginData = await loginRes.json();
  if (!loginData.success) {
    console.error('Login failed:', loginData);
    return;
  }

  const token = loginData.data.token;
  console.log('Login successful. Token acquired.');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-App-Type': 'mobile-app'
  };

  const getRequest = async (name, url) => {
    console.log(`\nTesting GET ${name}...`);
    const res = await fetch(`http://${ip}:5000/api/${url}`, { headers });
    console.log(`Response: ${res.status}`);
    const data = await res.json();
    await checkUserStatus(name);
  };

  const checkUserStatus = async (stepName) => {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    const user = await User.findOne({ email: 'vicky@gmail.com' });
    console.log(`🔍 User status after [${stepName}]: isActive = ${user.isActive}`);
    await mongoose.disconnect();
  };

  // Run GET tests
  await getRequest('Dashboard', 'analytics/dashboard');
  await getRequest('Inspector Summary', 'analytics/inspector-summary');
  await getRequest('My Review Stats', 'analytics/my-review-stats');
  await getRequest('Attendance Status', 'hr/attendance/my-status');

  // Test POST check-in
  console.log('\nTesting POST Check-In...');
  const checkinRes = await fetch(`http://${ip}:5000/api/hr/attendance/checkin`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lat: 12.948567,
      lng: 78.879605,
      accuracy: 100
    })
  });
  console.log(`Response: ${checkinRes.status}`);
  const checkinData = await checkinRes.json();
  console.log('Body:', JSON.stringify(checkinData, null, 2));
  await checkUserStatus('POST Check-In');

  // Test POST form response submission
  console.log('\nTesting POST Form Response Submit...');
  const responseSubmitRes = await fetch(`http://${ip}:5000/api/responses/840227cc-aa84-43c5-9ce0-ec6120084868`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      answers: {
        "q1": "Test Response Value"
      },
      chassisNumber: "TestChassis123",
      location: {
        latitude: 12.948567,
        longitude: 78.879605,
        accuracy: 100
      }
    })
  });
  console.log(`Response: ${responseSubmitRes.status}`);
  const submitData = await responseSubmitRes.json();
  console.log('Body:', JSON.stringify(submitData, null, 2));
  await checkUserStatus('POST Form Submit');
};

testUserFlow().catch(console.error);
