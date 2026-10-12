import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import request from 'supertest';
import { expect } from 'chai';
import app from '../server.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

describe('Auth login API', () => {
  let superAdmin;
  let tenant;
  let tenantAdmin;

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/form_test');
    }

    superAdmin = new User({
      username: 'superadmin_auth_login',
      email: 'superadmin-auth-login@example.com',
      password: 'Password123',
      role: 'superadmin',
      firstName: 'Super',
      lastName: 'Admin'
    });
    await superAdmin.save();

    const tenantId = new mongoose.Types.ObjectId();

    tenantAdmin = new User({
      username: 'tenant_admin_auth_login',
      email: 'tenant-admin-auth-login@example.com',
      password: 'Tenant123!',
      role: 'admin',
      firstName: 'Tenant',
      lastName: 'Admin',
      tenantId,
      createdBy: superAdmin._id
    });
    await tenantAdmin.save();

    tenant = new Tenant({
      _id: tenantId,
      name: 'Auth Login Tenant',
      slug: 'auth-login-tenant',
      companyName: 'Auth Login Tenant',
      isActive: true,
      createdBy: superAdmin._id,
      adminId: tenantAdmin._id
    });
    await tenant.save();
  });

  after(async () => {
    await User.deleteMany({ email: /auth-login@example.com$/ });
    await Tenant.deleteMany({ slug: /auth-login-tenant/ });
  });

  it('allows tenant admin to login with case-insensitive email', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'TENANT-ADMIN-AUTH-LOGIN@EXAMPLE.COM',
        password: 'Tenant123!'
      })
      .expect(200);

    expect(response.body.success).to.be.true;
    expect(response.body.data.user.email).to.equal('tenant-admin-auth-login@example.com');
  });
});
