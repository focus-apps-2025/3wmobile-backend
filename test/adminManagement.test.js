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

describe('Admin management API', () => {
  let superAdmin;
  let tenant;
  let adminUser;
  let adminToken;
  let subadminId;
  const subadminEmail = 'subadmin-admin-mgmt@example.com';
  const subadminPassword = 'SubAdmin123!';

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/form_test');
    }

    superAdmin = new User({
      username: 'superadmin_admin_mgmt',
      email: 'superadmin-admin-mgmt@example.com',
      password: 'Password123',
      role: 'superadmin',
      firstName: 'Super',
      lastName: 'Admin',
    });
    await superAdmin.save();

    const tenantId = new mongoose.Types.ObjectId();

    adminUser = new User({
      username: 'tenant_admin_mgmt',
      email: 'tenant-admin-admin-mgmt@example.com',
      password: 'Admin123!',
      role: 'admin',
      firstName: 'Tenant',
      lastName: 'Admin',
      tenantId,
      createdBy: superAdmin._id,
    });
    await adminUser.save();

    tenant = new Tenant({
      _id: tenantId,
      name: 'Admin Mgmt Tenant',
      slug: 'admin-mgmt-tenant',
      companyName: 'Admin Mgmt Tenant',
      isActive: true,
      createdBy: superAdmin._id,
      adminId: adminUser._id,
    });
    await tenant.save();

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email: adminUser.email,
        password: 'Admin123!',
      });

    expect(loginResponse.body.success).to.be.true;
    adminToken = loginResponse.body.data.token;
  });

  after(async () => {
    await User.deleteMany({ email: /admin-mgmt@example.com$/ });
    await Tenant.deleteMany({ slug: /admin-mgmt/ });
  });

  it('allows admin to create subadmin with permissions', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'subadmin_admin_mgmt',
        email: subadminEmail,
        password: subadminPassword,
        firstName: 'Sub',
        lastName: 'Admin',
        role: 'subadmin',
        permissions: ['dashboard:view', 'requests:view'],
      })
      .expect(201);

    expect(response.body.success).to.be.true;
    expect(response.body.data).to.have.property('user');
    const createdUser = response.body.data.user;
    expect(createdUser.role).to.equal('subadmin');
    expect(createdUser.permissions).to.deep.equal(['dashboard:view', 'requests:view']);

    subadminId = createdUser._id;

    const storedUser = await User.findById(subadminId);
    expect(storedUser).to.exist;
    expect(storedUser.tenantId.toString()).to.equal(tenant._id.toString());
    expect(storedUser.createdBy.toString()).to.equal(adminUser._id.toString());
  });

  it('prevents admin from creating another admin account', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'duplicate_admin_mgmt',
        email: 'admin-duplicate-admin-mgmt@example.com',
        password: 'Admin123!',
        firstName: 'Duplicate',
        lastName: 'Admin',
        role: 'admin',
      })
      .expect(403);

    expect(response.body.success).to.be.false;
    expect(response.body.message).to.equal('Admins cannot create additional admin accounts');
  });

  it('updates subadmin permissions', async () => {
    const response = await request(app)
      .put(`/api/users/${subadminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        permissions: ['dashboard:view'],
      })
      .expect(200);

    expect(response.body.success).to.be.true;
    expect(response.body.data.user.permissions).to.deep.equal(['dashboard:view']);

    const updatedUser = await User.findById(subadminId);
    expect(updatedUser.permissions).to.deep.equal(['dashboard:view']);
  });

  it('includes permissions in login response', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: subadminEmail,
        password: subadminPassword,
      })
      .expect(200);

    expect(response.body.success).to.be.true;
    expect(response.body.data.user.permissions).to.deep.equal(['dashboard:view']);
  });
});
