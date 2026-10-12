import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { expect } from 'chai';
import app from '../server.js';
import User from '../models/User.js';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const jwtSecret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const defaultTokenOptions = { expiresIn: '1h' };

const signTestToken = (user, overrides = {}) => {
  return jwt.sign(
    { userId: user._id.toString(), role: user.role },
    jwtSecret,
    { ...defaultTokenOptions, ...overrides }
  );
};

describe('FormCreator API Integration Tests', () => {
  let authToken;
  let testUser;
  let adminUser;
  let superAdmin;
  let testTenant;
  let createdFormId;

  before(async () => {
    // Connect to test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/form_test');
    }

    // Create superadmin
    superAdmin = new User({
      username: 'superadmin_fc',
      email: 'superadmin_fc@example.com',
      password: 'password123',
      role: 'superadmin',
      firstName: 'Super',
      lastName: 'Admin'
    });
    await superAdmin.save();

    // Create admin user
    const tempTenantId = new mongoose.Types.ObjectId();
    adminUser = new User({
      username: 'adminuser_fc',
      email: 'admin_fc@example.com',
      password: 'password123',
      role: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      tenantId: tempTenantId,
      createdBy: superAdmin._id
    });
    await adminUser.save();

    // Create test tenant
    testTenant = new Tenant({
      name: 'Test Company FC',
      slug: 'test-company-fc',
      companyName: 'Test Company FC Ltd',
      adminId: adminUser._id,
      isActive: true,
      createdBy: superAdmin._id
    });
    testTenant._id = tempTenantId;
    await testTenant.save();

    // Create test user
    testUser = new User({
      username: 'testuser_fc',
      email: 'test_fc@example.com',
      password: 'password123',
      role: 'teacher',
      firstName: 'Test',
      lastName: 'User',
      tenantId: testTenant._id,
      createdBy: adminUser._id
    });
    await testUser.save();

    // Generate auth token
    authToken = signTestToken(testUser);
  });

  after(async () => {
    // Clean up
    await User.deleteMany({ email: /_fc@/ });
    await Form.deleteMany({ title: /FormCreator Test/ });
    await Tenant.deleteMany({ slug: /test-company-fc/ });
  });

  describe('POST /api/forms - Form Creation', () => {
    it('should create a basic form successfully', async () => {
      const formData = {
        title: 'FormCreator Test Basic Form',
        description: 'A basic form created via FormCreator',
        isVisible: true,
        locationEnabled: true,
        sections: [
          {
            id: 'section-1',
            title: 'Basic Section',
            description: 'First section',
            questions: [
              {
                id: 'question-1',
                text: 'What is your name?',
                type: 'text',
                required: true
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(formData)
        .expect(201);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form).to.exist;
      expect(response.body.data.form.title).to.equal(formData.title);
      expect(response.body.data.form.sections).to.have.length(1);
      expect(response.body.data.form.sections[0].questions).to.have.length(1);

      createdFormId = response.body.data.form.id;
    });

    it('should create a question with image content', async () => {
      const imageDataUrl = 'data:image/png;base64,image-only-question';
      const formData = {
        title: 'FormCreator Test Image Question',
        description: 'Form with image-only question',
        isVisible: true,
        locationEnabled: false,
        sections: [
          {
            id: 'image-section',
            title: 'Image Section',
            description: 'Questions with images',
            questions: [
              {
                id: 'image-question',
                text: '',
                type: 'text',
                required: false,
                imageUrl: imageDataUrl
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(formData)
        .expect(201);

      expect(response.body.success).to.be.true;
      const createdQuestion = response.body.data.form.sections[0].questions[0];
      expect(createdQuestion.imageUrl).to.equal(imageDataUrl);
      expect(createdQuestion.text).to.equal(formData.sections[0].questions[0].text);
    });

    it('should create a complex form with multiple sections and question types', async () => {
      const complexFormData = {
        title: 'FormCreator Test Complex Form',
        description: 'A complex form with multiple sections and question types',
        isVisible: true,
        locationEnabled: false,
        sections: [
          {
            id: 'personal-info',
            title: 'Personal Information',
            description: 'Basic personal details',
            questions: [
              {
                id: 'name',
                text: 'Full Name',
                type: 'text',
                required: true
              },
              {
                id: 'email',
                text: 'Email Address',
                type: 'email',
                required: true
              },
              {
                id: 'age',
                text: 'Age Group',
                type: 'select',
                required: false,
                options: ['18-25', '26-35', '36-45', '46-55', '55+']
              }
            ]
          },
          {
            id: 'feedback',
            title: 'Feedback Section',
            description: 'Your feedback is valuable',
            questions: [
              {
                id: 'satisfaction',
                text: 'How satisfied are you?',
                type: 'radio',
                required: true,
                options: ['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied']
              },
              {
                id: 'comments',
                text: 'Additional Comments',
                type: 'textarea',
                required: false
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(complexFormData)
        .expect(201);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.sections).to.have.length(2);
      expect(response.body.data.form.sections[0].questions).to.have.length(3);
      expect(response.body.data.form.sections[1].questions).to.have.length(2);

      // Verify question types are preserved
      const nameQuestion = response.body.data.form.sections[0].questions.find(q => q.id === 'name');
      expect(nameQuestion.type).to.equal('text');
      expect(nameQuestion.required).to.be.true;

      const satisfactionQuestion = response.body.data.form.sections[1].questions.find(q => q.id === 'satisfaction');
      expect(satisfactionQuestion.type).to.equal('radio');
      expect(satisfactionQuestion.options).to.deep.equal(['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied']);
    });

    it('should fail to create form without authentication', async () => {
      const formData = {
        title: 'Unauthorized Form',
        description: 'Should not be created'
      };

      await request(app)
        .post('/api/forms')
        .send(formData)
        .expect(401);
    });

    it('should fail to create form with missing required fields', async () => {
      const invalidFormData = {
        description: 'Missing title'
        // No title provided
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidFormData)
        .expect(400);

      expect(response.body.success).to.be.false;
    });

    it('should fail to create form with invalid question data', async () => {
      const invalidFormData = {
        title: 'Invalid Form',
        description: 'Form with invalid questions',
        sections: [
          {
            id: 'section-1',
            title: 'Section',
            questions: [
              {
                id: 'invalid-question',
                text: '', // Empty text
                type: 'invalid-type', // Invalid type
                required: true
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidFormData)
        .expect(400);

      expect(response.body.success).to.be.false;
    });
  });

  describe('GET /api/forms - Form Retrieval', () => {
    it('should retrieve all forms for the tenant', async () => {
      const response = await request(app)
        .get('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(Array.isArray(response.body.data.forms)).to.be.true;
      expect(response.body.data.forms.length).to.be.at.least(1);

      // Verify our created form is in the list
      const ourForm = response.body.data.forms.find(f => f.id === createdFormId);
      expect(ourForm).to.exist;
      expect(ourForm.title).to.equal('FormCreator Test Basic Form');
    });

    it('should retrieve specific form by ID', async () => {
      const response = await request(app)
        .get(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.id).to.equal(createdFormId);
      expect(response.body.data.form.sections).to.have.length(1);
    });

    it('should fail to retrieve non-existent form', async () => {
      await request(app)
        .get('/api/forms/non-existent-id')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  describe('PUT /api/forms/:id - Form Updates', () => {
    it('should update form successfully', async () => {
      const updateData = {
        title: 'FormCreator Test Updated Form',
        description: 'Updated description',
        isVisible: false,
        sections: [
          {
            id: 'section-1',
            title: 'Updated Section',
            description: 'Updated section description',
            questions: [
              {
                id: 'question-1',
                text: 'Updated question text',
                type: 'text',
                required: false
              },
              {
                id: 'question-2',
                text: 'New question added',
                type: 'email',
                required: true
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .put(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.title).to.equal(updateData.title);
      expect(response.body.data.form.isVisible).to.be.false;
      expect(response.body.data.form.sections[0].questions).to.have.length(2);
    });

    it('should persist question image updates', async () => {
      const getResponse = await request(app)
        .get(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`);

      const currentForm = getResponse.body.data.form;
      const updatedForm = JSON.parse(JSON.stringify(currentForm));
      const imageDataUrl = 'data:image/png;base64,updated-image-question';

      updatedForm.sections[0].questions[0].imageUrl = imageDataUrl;

      const response = await request(app)
        .put(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updatedForm)
        .expect(200);

      const updatedQuestion = response.body.data.form.sections[0].questions[0];
      expect(updatedQuestion.imageUrl).to.equal(imageDataUrl);
      expect(updatedQuestion.text).to.equal(updatedForm.sections[0].questions[0].text);
    });

    it('should add new sections to existing form', async () => {
      // First get current form
      const getResponse = await request(app)
        .get(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`);

      const currentForm = getResponse.body.data.form;
      const updatedSections = [
        ...currentForm.sections,
        {
          id: 'new-section',
          title: 'New Section Added',
          description: 'Dynamically added section',
          questions: [
            {
              id: 'new-question',
              text: 'Question in new section',
              type: 'textarea',
              required: false
            }
          ]
        }
      ];

      const response = await request(app)
        .put(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ ...currentForm, sections: updatedSections })
        .expect(200);

      expect(response.body.data.form.sections).to.have.length(2);
      expect(response.body.data.form.sections[1].title).to.equal('New Section Added');
    });
  });

  describe('Form Visibility Management', () => {
    it('should update form visibility', async () => {
      const response = await request(app)
        .patch(`/api/forms/${createdFormId}/visibility`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ isVisible: true })
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.isVisible).to.be.true;
    });
  });

  describe('Form Duplication', () => {
    it('should duplicate form successfully', async () => {
      const response = await request(app)
        .post(`/api/forms/${createdFormId}/duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.title).to.include('(Copy)');
      expect(response.body.data.form.sections).to.have.length(2); // Same as original
    });
  });

  describe('Form Analytics', () => {
    it('should get form analytics', async () => {
      const response = await request(app)
        .get(`/api/forms/${createdFormId}/analytics`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data).to.have.property('totalResponses');
      expect(response.body.data).to.have.property('form');
      expect(response.body.data.form.id).to.equal(createdFormId);
    });
  });

  describe('Form Deletion', () => {
    it('should delete form successfully', async () => {
      const response = await request(app)
        .delete(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;

      // Verify form is deleted
      await request(app)
        .get(`/api/forms/${createdFormId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed JSON gracefully', async () => {
      await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);
    });

    it('should handle extremely large form data', async () => {
      const largeFormData = {
        title: 'Large Form Test',
        description: 'Testing with many sections and questions',
        sections: []
      };

      // Create 10 sections with 10 questions each
      for (let s = 0; s < 10; s++) {
        const section = {
          id: `section-${s}`,
          title: `Section ${s}`,
          questions: []
        };

        for (let q = 0; q < 10; q++) {
          section.questions.push({
            id: `question-${s}-${q}`,
            text: `Question ${q} in section ${s} with some additional text to make it longer`,
            type: 'text',
            required: Math.random() > 0.5
          });
        }

        largeFormData.sections.push(section);
      }

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(largeFormData)
        .expect(201);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.sections).to.have.length(10);
      expect(response.body.data.form.sections[0].questions).to.have.length(10);
    });

    it('should handle special characters in form data', async () => {
      const specialCharsForm = {
        title: 'Form with Spëcial Chärs 🎉 émojis',
        description: 'Testing special characters: àáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ',
        sections: [
          {
            id: 'special-section',
            title: 'Spëcial Séction 📝',
            questions: [
              {
                id: 'special-question',
                text: 'Quëstion with spëcial chärs? ¿¡',
                type: 'text',
                required: true
              }
            ]
          }
        ]
      };

      const response = await request(app)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send(specialCharsForm)
        .expect(201);

      expect(response.body.success).to.be.true;
      expect(response.body.data.form.title).to.equal(specialCharsForm.title);
    });

    it('should handle concurrent form operations', async () => {
      const formPromises = [];

      // Create multiple forms concurrently
      for (let i = 0; i < 5; i++) {
        const formData = {
          title: `Concurrent Form ${i}`,
          description: `Form created in concurrent operation ${i}`,
          sections: [
            {
              id: `section-${i}`,
              title: `Section ${i}`,
              questions: [
                {
                  id: `question-${i}`,
                  text: `Question ${i}`,
                  type: 'text',
                  required: true
                }
              ]
            }
          ]
        };

        formPromises.push(
          request(app)
            .post('/api/forms')
            .set('Authorization', `Bearer ${authToken}`)
            .send(formData)
        );
      }

      const responses = await Promise.all(formPromises);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).to.equal(201);
        expect(response.body.success).to.be.true;
      });
    });
  });
});