import fetch from 'node-fetch';

async function run() {
  try {
    const loginRes = await fetch('https://threew-vu4v.onrender.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'lmpladmin@focus.com', password: '123456' })
    });

    const loginData = await loginRes.json();
    console.log('Login Result:', loginData.success, 'Token:', !!loginData.data?.token);
    
    if (!loginData.data?.token) {
      console.error('Failed to log in:', loginData);
      return;
    }

    const token = loginData.data.token;

    const formsRes = await fetch('https://threew-vu4v.onrender.com/api/forms', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const formsData = await formsRes.json();
    console.log('\n/api/forms Status:', formsRes.status);
    console.log('Forms Data Success:', formsData.success);
    console.log('Forms Count:', formsData.data?.forms?.length);
    if (formsData.data?.forms) {
      console.log('Form Titles:', formsData.data.forms.map(f => ({ id: f._id || f.id, title: f.title })));
    } else {
      console.log('Full formsData:', formsData);
    }

  } catch (err) {
    console.error('API Test Error:', err);
  }
}

run();
