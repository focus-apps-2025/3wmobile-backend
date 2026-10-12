import mongoose from 'mongoose';
import Form from '../models/Form.js';
import Response from '../models/Response.js';
import Parameter from '../models/Parameter.js';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_FILE_TYPES = ['image', 'pdf', 'excel', 'stp', 'pvz', 'doc', 'docx'];

const applyPopulate = (query, populateOptions) => {
  if (!populateOptions) {
    return query;
  }

  let populatedQuery = query;

  if (Array.isArray(populateOptions)) {
    populateOptions.forEach((option) => {
      populatedQuery = populatedQuery.populate(option);
    });
  } else {
    populatedQuery = populatedQuery.populate(populateOptions);
  }

  return populatedQuery;
};





const findFormByIdentifier = async (identifier, populateOptions) => {
  let formQuery = applyPopulate(Form.findOne({ id: identifier }), populateOptions);
  let form = await formQuery;

  if (!form && mongoose.Types.ObjectId.isValid(identifier)) {
    formQuery = applyPopulate(Form.findById(identifier), populateOptions);
    form = await formQuery;
  }

  return form;
};

/**
 * Normalize question types before form creation (handles spaces/slashes)
 * Also filters allowedFileTypes to ensure they match the backend enum
 */
const normalizeQuestionTypes = (question) => {
  const typeMap = {
    // Legacy/UI type names - without spaces/slashes
    'shorttext': 'text', 'shortint': 'text',
    'multiplechoice': 'radio',
    'longtext': 'paragraph', 'longinput': 'paragraph',
    'dropdown': 'select', 'checkboxes': 'checkbox',
    'fileupload': 'file', 'file upload': 'file',

    // Yes/No variations
    'yesnona': 'yesNoNA', 'yesno': 'yesNoNA',

    // Core types - pass through
    'email': 'email', 'url': 'url', 'tel': 'tel',
    'date': 'date', 'time': 'time', 'file': 'file', 'range': 'range',
    'rating': 'rating', 'scale': 'scale', 'radio-grid': 'radio-grid',
    'radiogrid': 'radio-grid', 'checkbox-grid': 'checkbox-grid', 'checkboxgrid': 'checkbox-grid',
    'radio-image': 'radio-image', 'radioimage': 'radio-image',
    'search-select': 'search-select', 'searchselect': 'search-select',
    'number': 'number', 'location': 'location',
    'boolean': 'boolean', 'textarea': 'textarea',
    'text': 'text', 'radio': 'radio', 'paragraph': 'paragraph',
    'select': 'select', 'checkbox': 'checkbox', 'productnpstgwbuckets': 'productNPSTGWBuckets',
    'chassis-with-zone': 'chassis-with-zone',
    'chassiswithzone': 'chassis-with-zone',
    'chassis-without-zone': 'chassis-without-zone',
    'chassiswithoutzone': 'chassis-without-zone',
    'zone-in': 'zone-in',
    'zonein': 'zone-in',
    'zone-out': 'zone-out',
    'zoneout': 'zone-out',
    'productnpstgwbuckets': 'productNPSTGWBuckets'
  };

  if (question?.type) {
    let normalizedType = String(question.type)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*\/\s*/g, '');

    const mappedType = typeMap[normalizedType] || typeMap[normalizedType.replace(/\s/g, '')] || question.type;

    // Log normalization if it changed
    if (question.type !== mappedType) {
      // console.log(`Normalizing question type: "${question.type}" → "${mappedType}"`);
    }
    question.type = mappedType;
  }

  // Handle allowedFileTypes validation
  if (question?.type === 'file') {
    if (Array.isArray(question.allowedFileTypes)) {
      question.allowedFileTypes = question.allowedFileTypes.filter((type) =>
        ALLOWED_FILE_TYPES.includes(type)
      );
      if (question.allowedFileTypes.length === 0) {
        delete question.allowedFileTypes;
      }
    } else if (question?.allowedFileTypes !== undefined) {
      delete question.allowedFileTypes;
    }
  } else if (question?.allowedFileTypes !== undefined) {
    // If not a file type question, remove allowedFileTypes if present
    delete question.allowedFileTypes;
  }

  // Recursively normalize follow-up questions
  if (Array.isArray(question?.followUpQuestions)) {
    question.followUpQuestions = question.followUpQuestions.map(fq => normalizeQuestionTypes(fq));
  }

  return question;
};


class SectionWeightageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SectionWeightageError';
  }
}

const WEIGHTAGE_TOLERANCE = 0.01;

const normalizeSectionWeightage = (sections) => {
  if (!Array.isArray(sections)) {
    return 0;
  }

  let total = 0;

  sections.forEach((section, index) => {
    if (!section) {
      return;
    }

    const weightValue = section.weightage ?? 0;
    const weightage = Number(weightValue);

    if (Number.isNaN(weightage)) {
      throw new SectionWeightageError(
        `Section "${section.title || section.id}" has an invalid weightage value: ${weightValue}`
      );
    }

    if (weightage < 0 || weightage > 100) {
      throw new SectionWeightageError(
        `Section "${section.title || section.id}" must have a weightage between 0 and 100. Received: ${weightage}`
      );
    }

    section.weightage = weightage;
    total += weightage;
  });

  if (total > 0 && Math.abs(total - 100) > WEIGHTAGE_TOLERANCE) {
    throw new SectionWeightageError(
      `Section weightage must add up to 100%. Current total: ${total.toFixed(2)}%`
    );
  }

  return total;
};


export const createForm = async (req, res) => {
  try {
    console.log('=== Create Form Request ===');
    console.log('User:', req.user?.email, 'Role:', req.user?.role);
    console.log('Request body keys:', Object.keys(req.body));

    // Determine tenantId based on user role
    let tenantId;
    const isGlobal = req.body.isGlobal === true || req.body.isGlobal === 'true';

    if (req.user.role === 'superadmin') {
      // SuperAdmin can create global forms or forms for a specific tenant
      tenantId = req.body.tenantId;
      console.log('SuperAdmin - tenantId from body:', tenantId);
      if (!tenantId && !isGlobal) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required for superadmin to create tenant-specific forms'
        });
      }
    } else {
      // Other users use their own tenantId
      tenantId = req.user.tenantId;
      console.log('Regular user - tenantId from user:', tenantId);
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'User does not have a tenantId assigned'
        });
      }
    }

    // Validate tenantId is a valid ObjectId (only if tenantId is provided)
    if (tenantId && !mongoose.Types.ObjectId.isValid(tenantId)) {
      console.error('Invalid tenantId format:', tenantId);
      return res.status(400).json({
        success: false,
        message: 'Invalid tenantId format. Must be a valid MongoDB ObjectId.'
      });
    }
    console.log('=== DEBUG: Checking suggestion in request ===');
    if (req.body.sections && req.body.sections[0] && req.body.sections[0].questions) {
      req.body.sections[0].questions.forEach((q, idx) => {
        console.log(`Question ${idx}: "${q.text}"`);
        console.log(`  Has suggestion?`, 'suggestion' in q);
        console.log(`  Suggestion value:`, q.suggestion);
      });
    }


    // Check form limits for free plan
    const Tenant = (await import('../models/Tenant.js')).default;
    const tenant = await Tenant.findById(tenantId);
    if (tenant && tenant.subscription && tenant.subscription.plan === 'free') {
      const formCount = await Form.countDocuments({ tenantId });
      const maxForms = tenant.subscription.maxForms || 5;
      if (formCount >= maxForms) {
        return res.status(403).json({
          success: false,
          message: `Your free trial limit of ${maxForms} forms has been reached. Please contact admin to upgrade your plan.`
        });
      }
    }

    const formData = {
      ...req.body,
      id: req.body.id || uuidv4(),
      createdBy: req.user._id,
      tenantId: tenantId,
      isGlobal: isGlobal,
      sharedWithTenants: req.body.sharedWithTenants || []
    };

    // DEBUG: Check formData before creating form
    console.log('=== DEBUG: formData before Form creation ===');
    console.log('First question suggestion:', formData.sections?.[0]?.questions?.[0]?.suggestion);
    // Normalize question types before form creation (handles spaces/slashes)
    // Normalize all sections using global utility
    if (Array.isArray(formData.sections)) {
      formData.sections.forEach(section => {
        if (Array.isArray(section.questions)) {
          section.questions = section.questions.map(q => normalizeQuestionTypes(q));
        }
      });
    }

    // Normalize top-level follow-up questions using global utility
    if (Array.isArray(formData.followUpQuestions)) {
      formData.followUpQuestions = formData.followUpQuestions.map(q => normalizeQuestionTypes(q));
    }



    const form = new Form(formData);

    // DEBUG: Check form document before save
    console.log('=== DEBUG: Form document before save ===');
    console.log('First question suggestion in mongoose doc:', form.sections?.[0]?.questions?.[0]?.suggestion);

    try {
      normalizeSectionWeightage(formData.sections);
    } catch (error) {
      if (error instanceof SectionWeightageError) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }
      throw error;
    }

    console.log('Form data to save:', {
      id: formData.id,
      title: formData.title,
      description: formData.description?.substring(0, 50),
      sectionsCount: formData.sections?.length,
      tenantId: formData.tenantId,
      createdBy: formData.createdBy
    });


    await form.save();

    // If parentFormId is specified, auto-link to parent's childForms
    if (formData.parentFormId) {
      try {
        const parentForm = await Form.findOne({
          $or: [
            { id: formData.parentFormId },
            { _id: mongoose.Types.ObjectId.isValid(formData.parentFormId) ? formData.parentFormId : null }
          ]
        });
        if (parentForm) {
          if (!parentForm.childForms) parentForm.childForms = [];
          const exists = parentForm.childForms.some(cf => cf.formId === form.id || cf.formId === form._id.toString());
          if (!exists) {
            parentForm.childForms.push({
              formId: form.id || form._id.toString(),
              formTitle: form.title,
              order: parentForm.childForms.length
            });
            await parentForm.save();
          }
        }
      } catch (linkErr) {
        console.warn('Auto-link child form error:', linkErr);
      }
    }

    console.log('Form created successfully with ID:', form.id);


    res.status(201).json({
      success: true,
      message: 'Form created successfully',
      data: { form }
    });


  } catch (error) {
    console.error('=== Create form error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);

    if (error.code === 11000) {
      console.error('Duplicate key error:', error.keyValue);
      return res.status(400).json({
        success: false,
        message: 'Form with this ID already exists'
      });
    }

    // Log the full error for debugging
    if (error.name === 'ValidationError') {
      console.error('Validation error details:', JSON.stringify(error.errors, null, 2));
      const errorDetails = Object.keys(error.errors).map(key => ({
        field: key,
        message: error.errors[key].message,
        value: error.errors[key].value
      }));
      console.error('Formatted errors:', errorDetails);

      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errorDetails
      });
    }

    console.error('Unhandled error in createForm:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error: error.message
    });
  }
};

export const getAllForms = async (req, res) => {
  try {
    const { page = 1, limit = 1000, search, isVisible, isActive, createdBy, isGlobal, tenantId: queryTenantId } = req.query;

    let query = { ...req.tenantFilter };

    // If not superadmin, also include global forms shared with this tenant
    if (req.user.role !== 'superadmin' && req.user.tenantId) {
      const tenantIdStr = req.user.tenantId.toString();
      const tenantIdObj = mongoose.Types.ObjectId.isValid(tenantIdStr)
        ? new mongoose.Types.ObjectId(tenantIdStr)
        : null;
      const tenantValues = [tenantIdStr, tenantIdObj].filter(Boolean);

      query = {
        $or: [
          { tenantId: { $in: tenantValues } },
          { sharedWithTenants: { $in: tenantValues } },
          { "chassisTenantAssignments.assignedTenants": tenantIdStr }
        ]
      };
    } else if (req.user.role === 'superadmin' && queryTenantId) {
      // Superadmin can filter by a specific tenantId passed as query param
      const tenantIdStr = queryTenantId.toString();
      const tenantIdObj = mongoose.Types.ObjectId.isValid(tenantIdStr)
        ? new mongoose.Types.ObjectId(tenantIdStr)
        : null;
      const tenantValues = [tenantIdStr, tenantIdObj].filter(Boolean);

      query = {
        $or: [
          { tenantId: { $in: tenantValues } },
          { sharedWithTenants: { $in: tenantValues } }
        ]
      };
    }

    // Filter by global status
    if (isGlobal !== undefined) {
      const isGlobalValue = isGlobal === 'true';
      if (query.$or) {
        // If we already have a tenant filter $or, we need to $and it with isGlobal
        query = {
          $and: [
            { $or: query.$or },
            { isGlobal: isGlobalValue }
          ]
        };
      } else {
        query.isGlobal = isGlobalValue;
      }
    }

    // Search by title or description
    if (search) {
      const searchOr = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];

      if (query.$or) {
        query = {
          $and: [
            { $or: query.$or },
            { $or: searchOr }
          ]
        };
      } else {
        query.$or = searchOr;
      }
    }

    // Filter by visibility
    if (isVisible !== undefined) {
      query.isVisible = isVisible === 'true';
    }

    // Filter by active status
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // Filter by creator
    if (createdBy) {
      query.createdBy = createdBy;
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: [
        {
          path: 'createdBy',
          select: 'username firstName lastName email'
        },
        {
          path: 'tenantId',
          select: 'companyName name slug'
        }
      ]
    };

    const [forms, total] = await Promise.all([
      Form.find(query)
        .populate(options.populate)
        .sort(options.sort)
        .limit(options.limit * 1)
        .skip((options.page - 1) * options.limit)
        .lean({ virtuals: true }),
      Form.countDocuments(query)
    ]);

    const formIdsForCounts = forms
      .flatMap((form) => [
        form.id ? form.id.toString() : null,
        form._id ? form._id.toString() : null
      ])
      .filter(Boolean);

    let responseCountsMap = new Map();
    if (formIdsForCounts.length > 0) {
      const currentTenantId = req.user?.tenantId?.toString();

      // Separate forms into chassis-shared vs normal
      const chassisSharedFormIds = [];
      const normalFormIds = [];

      for (const form of forms) {
        const id1 = form.id ? form.id.toString() : '';
        const id2 = form._id ? form._id.toString() : '';
        const formId = id1 || id2;
        if (!formId) continue;

        const tenantIdStr = typeof form.tenantId === 'object' && form.tenantId ? form.tenantId._id?.toString() : form.tenantId?.toString();
        const isOwner = tenantIdStr === currentTenantId;
        const isShared = form.sharedWithTenants?.some(t => t.toString() === currentTenantId);
        const chassisAssignments = form.chassisTenantAssignments || [];
        const hasChassisShare = chassisAssignments.some(
          a => a.assignedTenants && a.assignedTenants.includes(currentTenantId)
        );

        if (!isOwner && !isShared && hasChassisShare) {
          chassisSharedFormIds.push({ form, formId, id1, id2, chassisAssignments });
        } else {
          if (id1) normalFormIds.push(id1);
          if (id2 && id2 !== id1) normalFormIds.push(id2);
        }
      }

      // ✅ Fast path: use aggregation to get counts matching both questionId & formId (string and ObjectId)
      if (normalFormIds.length > 0) {
        const matchIds = [];
        normalFormIds.forEach((strId) => {
          matchIds.push(strId);
          if (mongoose.Types.ObjectId.isValid(strId)) {
            matchIds.push(new mongoose.Types.ObjectId(strId));
          }
        });

        const countAgg = await Response.aggregate([
          {
            $match: {
              $or: [
                { questionId: { $in: matchIds } },
                { formId: { $in: matchIds } }
              ],
              isSectionSubmit: { $ne: true }
            }
          },
          {
            $project: {
              resolvedFormId: {
                $ifNull: [
                  "$questionId",
                  { $toString: "$formId" }
                ]
              }
            }
          },
          {
            $group: {
              _id: "$resolvedFormId",
              count: { $sum: 1 }
            }
          }
        ]);

        countAgg.forEach(({ _id, count }) => {
          if (_id) responseCountsMap.set(_id.toString(), count);
        });
      }

      // Chassis-shared forms: targeted countDocuments per chassis set
      for (const { form, formId, id1, id2, chassisAssignments } of chassisSharedFormIds) {
        const myChassis = chassisAssignments
          .filter(a => a.assignedTenants?.includes(currentTenantId))
          .map(a => a.chassisNumber)
          .filter(Boolean);

        if (myChassis.length > 0) {
          const chassisQuestion = form.sections?.flatMap(s => s.questions || [])
            .find(q => q.type === 'chassisNumber')
            || form.followUpQuestions?.find(q => q.type === 'chassisNumber');
          const chassisFieldId = chassisQuestion?.id || 'chassis_number';

          const checkIds = [id1, id2].filter(Boolean);
          const checkMatchIds = [];
          checkIds.forEach(i => {
            checkMatchIds.push(i);
            if (mongoose.Types.ObjectId.isValid(i)) checkMatchIds.push(new mongoose.Types.ObjectId(i));
          });

          // Count only responses whose chassis answer matches assigned chassis numbers
          const filteredCount = await Response.countDocuments({
            $or: [
              { questionId: { $in: checkMatchIds } },
              { formId: { $in: checkMatchIds } }
            ],
            isSectionSubmit: { $ne: true },
            $and: [
              {
                $or: [
                  { [`answers.${chassisFieldId}`]: { $in: myChassis } },
                  { [`answers.chassis_number`]: { $in: myChassis } }
                ]
              }
            ]
          });
          if (id1) responseCountsMap.set(id1, filteredCount);
          if (id2) responseCountsMap.set(id2, filteredCount);
        } else {
          if (id1) responseCountsMap.set(id1, 0);
          if (id2) responseCountsMap.set(id2, 0);
        }
      }
    }

    const formsWithCounts = forms.map((form) => {
      const id1 = form.id ? form.id.toString() : "";
      const id2 = form._id ? form._id.toString() : "";
      const count1 = id1 ? (responseCountsMap.get(id1) || 0) : 0;
      const count2 = (id2 && id2 !== id1) ? (responseCountsMap.get(id2) || 0) : 0;
      const responseCount = count1 + count2;
      return {
        ...form,
        responseCount
      };
    });

    res.json({
      success: true,
      data: {
        forms: formsWithCounts,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalForms: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get all forms error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getPublicForms = async (req, res) => {
  try {
    const { tenantSlug } = req.params;

    // If tenantSlug is provided (public customer access), find tenant by slug
    let query = { isActive: true, isVisible: true };

    if (tenantSlug) {
      // Import Tenant model
      const Tenant = mongoose.model('Tenant');
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Business not found or inactive'
        });
      }

      query = {
        ...query,
        $or: [
          { tenantId: tenant._id },
          { sharedWithTenants: tenant._id }
        ]
      };
    } else if (req.tenantFilter && req.user && req.user.role !== 'superadmin') {
      // Authenticated user - include shared global forms
      const tenantId = req.user.tenantId instanceof mongoose.Types.ObjectId
        ? req.user.tenantId
        : new mongoose.Types.ObjectId(req.user.tenantId);

      query = {
        ...query,
        $or: [
          { tenantId: tenantId },
          { sharedWithTenants: tenantId }
        ]
      };
    }

    const forms = await Form.find(query)
      .select('id title description logoUrl imageUrl createdAt tenantId isActive isVisible sections parentFormId viewType')
      .populate('sections.questions')
      .sort({ createdAt: -1 })
      .lean();

    const parentForms = forms.filter((form) => !form.parentFormId);
    const publicForms = parentForms.filter((form) => form.isVisible === true);

    res.json({
      success: true,
      data: { forms: publicForms }
    });

  } catch (error) {
    console.error('Get public forms error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFormById = async (req, res) => {
  try {
    const { id, tenantSlug } = req.params;

    console.log('[getFormById] Looking for form with ID:', id);
    const populateOptions = req.populateOptions || {
      path: 'createdBy',
      select: 'username firstName lastName email'
    };

    // Use .lean() directly
    let form = await Form.findOne({ id: id }).populate(populateOptions.path, populateOptions.select).lean();
    console.log('[getFormById] Found by id field:', !!form);

    if (!form && mongoose.Types.ObjectId.isValid(id)) {
      form = await Form.findById(id).populate(populateOptions.path, populateOptions.select).lean();
      console.log('[getFormById] Found by _id field:', !!form);
    }

    if (!form) {
      console.log('[getFormById] Form not found in database');
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    console.log('[getFormById] Form found:', form.title, 'isVisible:', form.isVisible);

    // Ensure viewType has a default value if missing (Mongoose lean() doesn't include defaults for missing fields)
    if (!form.viewType) {
      form.viewType = 'section-wise';
    }

    // Permission check for authenticated users (not public slug access)
    // Superadmins and Admins can view forms across tenants (mutation routes still strictly restrict editing to owning tenant)
    if (!tenantSlug && req.user && req.user.role !== 'superadmin' && req.user.role !== 'admin' && !req.user.isGuest) {
      if (!req.user.tenantId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Organization identification required.'
        });
      }

      const userTenantId = req.user.tenantId.toString();
      const isGlobal = form.isGlobal === true;
      const isOwnedByTenant = form.tenantId && form.tenantId.toString() === userTenantId;
      const isSharedWithTenant = form.sharedWithTenants && form.sharedWithTenants.some(tId => tId && tId.toString() === userTenantId);
      const hasChassisShare = Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.some(
        a => a.assignedTenants && a.assignedTenants.includes(userTenantId)
      );

      if (!isGlobal && !isOwnedByTenant && !isSharedWithTenant && !hasChassisShare) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. This form is not available for your organization.'
        });
      }
    }

    // For public access with tenant slug, verify tenant and form visibility
    if (tenantSlug) {
      const Tenant = mongoose.model('Tenant');
      const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true });

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Business not found or inactive'
        });
      }

      // Verify form belongs to this tenant or is shared with it
      const isOwnedByTenant = form.tenantId && form.tenantId.toString() === tenant._id.toString();
      const isSharedWithTenant = form.sharedWithTenants && form.sharedWithTenants.some(tId => tId && tId.toString() === tenant._id.toString());

      if (!isOwnedByTenant && !isSharedWithTenant) {
        return res.status(404).json({
          success: false,
          message: 'Form not found'
        });
      }

      // Check if form is visible
      if (!form.isVisible) {
        return res.status(404).json({
          success: false,
          message: 'Form not found'
        });
      }
    }

    // For public access (no req.user and no tenantSlug), check if form is visible
    if (!req.user && !tenantSlug && !form.isVisible) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Debug logging - ADD THIS TO CHECK SUGGESTION
    console.log('=== DEBUG: Checking suggestions in form ===');
    console.log('Form ID:', form.id);
    console.log('Form type:', typeof form);

    if (form.sections && form.sections.length > 0) {
      form.sections.forEach((section, idx) => {
        console.log(`Section ${idx}: ${section.title}, Questions: ${section.questions?.length || 0}`);
        if (section.questions) {
          section.questions.forEach((q, qIdx) => {
            console.log(`  Q${qIdx}: "${q.text}"`);
            console.log(`    Has suggestion field?`, 'suggestion' in q);
            console.log(`    Suggestion value:`, q.suggestion);
            console.log(`    All keys:`, Object.keys(q));
          });
        }
      });
    }

    // Check for invite status if inviteId is provided in query
    if (req.query.inviteId) {
      const FormInvite = mongoose.model('FormInvite');
      const invite = await FormInvite.findOne({
        formId: id,
        inviteId: req.query.inviteId
      });

      if (invite && invite.status === 'responded') {
        return res.status(409).json({
          success: false,
          message: 'ALREADY_SUBMITTED',
          data: {
            email: invite.email,
            submittedAt: invite.respondedAt
          }
        });
      }
    }

    let formObj = form.toObject ? form.toObject() : { ...form };

    try {
      // 1. Resolve Child Forms (Follow-up forms) and calculate their response counts
      const parentIdentifiers = [formObj.id, formObj._id ? formObj._id.toString() : null].filter(Boolean);
      const dbChildren = await Form.find({
        parentFormId: { $in: parentIdentifiers }
      }).select('id _id title sections createdAt').lean();

      const childMap = new Map();
      (formObj.childForms || []).forEach(cf => {
        if (cf.formId) {
          childMap.set(cf.formId, {
            formId: cf.formId,
            formTitle: cf.formTitle || 'Follow up form',
            order: cf.order ?? 0
          });
        }
      });

      dbChildren.forEach((dc) => {
        const key = dc.id || dc._id.toString();
        if (!childMap.has(key)) {
          childMap.set(key, {
            formId: key,
            formTitle: dc.title,
            order: childMap.size
          });
        }
        const item = childMap.get(key);
        item._id = dc._id.toString();
        item.id = dc.id;
        item.formTitle = dc.title || item.formTitle;
      });

      const enrichedChildForms = [];
      for (const [key, cf] of childMap.entries()) {
        const cIds = [cf.formId, cf.id, cf._id].filter(Boolean);
        const count = await Response.countDocuments({
          questionId: { $in: cIds },
          isSectionSubmit: { $ne: true }
        });
        enrichedChildForms.push({
          ...cf,
          responseCount: count
        });
      }
      formObj.childForms = enrichedChildForms;

      // 2. If this form itself is a child form, attach parentForm details
      if (formObj.parentFormId) {
        const pDoc = await Form.findOne({
          $or: [
            { id: formObj.parentFormId },
            { _id: mongoose.Types.ObjectId.isValid(formObj.parentFormId) ? new mongoose.Types.ObjectId(formObj.parentFormId) : null }
          ].filter(Boolean)
        }).select('id _id title sections chassisNumbers').lean();

        if (pDoc) {
          const pCount = await Response.countDocuments({
            questionId: { $in: [pDoc.id, pDoc._id.toString()] },
            isSectionSubmit: { $ne: true }
          });
          formObj.parentForm = {
            _id: pDoc._id.toString(),
            id: pDoc.id,
            title: pDoc.title,
            responseCount: pCount
          };

          // If child form has empty sections, inherit sections from parent form with Chassis Number tracking
          if ((!formObj.sections || formObj.sections.length === 0) && pDoc.sections && pDoc.sections.length > 0) {
            formObj.sections = pDoc.sections.map((sec, sIdx) => ({
              ...sec,
              questions: (sec.questions || []).map((q, qIdx) => {
                if (sIdx === 0 && qIdx === 0) {
                  return {
                    ...q,
                    text: q.text && q.text.toLowerCase().includes('chassis') ? q.text : 'Chassis Number',
                    trackResponseQuestion: true,
                    trackResponseRank: true,
                    trackResponseRankLabel: 'Chassis Number',
                    trackResponseQuestionLabel: 'Chassis Number',
                    placeholder: 'Enter Chassis Number / VIN...'
                  };
                }
                return { ...q };
              })
            }));
          }

          // Inherit chassisNumbers from parent if child has none
          if ((!formObj.chassisNumbers || formObj.chassisNumbers.length === 0) && pDoc.chassisNumbers && pDoc.chassisNumbers.length > 0) {
            formObj.chassisNumbers = pDoc.chassisNumbers;
          }
        }
      }

      // 3. If form still has no sections, synthesize a default section with a tracked Chassis Number question
      if (!formObj.sections || formObj.sections.length === 0) {
        const defaultQuestions = formObj.followUpQuestions && formObj.followUpQuestions.length > 0
          ? formObj.followUpQuestions
          : [
              {
                id: 'chassis-number-q',
                text: 'Chassis Number',
                type: 'text',
                required: true,
                trackResponseQuestion: true,
                trackResponseRank: true,
                trackResponseRankLabel: 'Chassis Number',
                trackResponseQuestionLabel: 'Chassis Number',
                placeholder: 'Enter Chassis Number / VIN...'
              }
            ];

        formObj.sections = [
          {
            id: 'section-chassis',
            title: 'Chassis Number',
            questions: defaultQuestions
          }
        ];
      }
    } catch (enrichErr) {
      console.warn('[getFormById] Failed to enrich child/parent relationships:', enrichErr);
    }

    res.json({
      success: true,
      data: { form: formObj }
    });

  } catch (error) {
    console.error('Get form by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateForm = async (req, res) => {
  try {
    const { id } = req.params;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      const userPerms = req.user.permissions || [];
      const formIdStr = form._id?.toString();
      const customIdStr = form.id?.toString();
      const hasEditPerm = userPerms.includes(`analytics:form:${formIdStr}:edit`) ||
        (customIdStr && userPerms.includes(`analytics:form:${customIdStr}:edit`)) ||
        userPerms.includes(`analytics:form:${formIdStr}`) ||
        userPerms.includes('analytics:editForms') ||
        userPerms.includes('analytics:manageForms') ||
        userPerms.includes('analytics:manage') ||
        userPerms.includes('analytics:edit') ||
        userPerms.includes('analytics:*');
      if (!hasEditPerm) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to edit this form.'
        });
      }
    }

    // For admin, ensure they can only edit forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only edit forms in your organization.'
      });
    }

    // Update form
    const updateData = { ...req.body };

    // Only superadmin and admin can change isGlobal and sharedWithTenants
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
      delete updateData.isGlobal;
      delete updateData.sharedWithTenants;
      delete updateData.tenantId;
    }
    // Admin can update sharedWithTenants but not isGlobal or tenantId
    if (req.user.role === 'admin') {
      delete updateData.isGlobal;
      delete updateData.tenantId;
    }

    Object.assign(form, updateData);

    try {
      normalizeSectionWeightage(form.sections);
    } catch (error) {
      if (error instanceof SectionWeightageError) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }
      throw error;
    }

    // Normalize question types before saving (handles spaces/slashes) using global utility
    if (Array.isArray(form.sections)) {
      form.sections.forEach(section => {
        if (Array.isArray(section.questions)) {
          section.questions = section.questions.map(q => normalizeQuestionTypes(q));
        }
      });
    }

    if (Array.isArray(form.followUpQuestions)) {
      form.followUpQuestions = form.followUpQuestions.map(q => normalizeQuestionTypes(q));
    }

    await form.save();

    res.json({
      success: true,
      message: 'Form updated successfully',
      data: { form }
    });

  } catch (error) {
    console.error('Update form error:', error);

    if (error instanceof mongoose.Error.ValidationError) {
      const formattedErrors = Object.values(error.errors || {}).map((err) => ({
        field: err.path,
        message: err.message
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: formattedErrors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteForm = async (req, res) => {
  try {
    const { id } = req.params;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      // Check if this id exists as an orphaned child form in any parent's childForms
      const cleaned = await Form.updateMany(
        {},
        { $pull: { childForms: { formId: id } } }
      );
      await Response.deleteMany({
        $or: [{ questionId: id }, { formId: id }]
      });
      if (cleaned.modifiedCount > 0) {
        return res.json({
          success: true,
          message: 'Unlinked and cleaned orphaned child form successfully'
        });
      }

      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    const isSuperAdmin = req.user.role === 'superadmin';
    const isAdmin = req.user.role === 'admin';
    const formTenantIdStr = (form.tenantId?._id || form.tenantId)?.toString();
    const userTenantIdStr = (req.user.tenantId?._id || req.user.tenantId)?.toString();
    const formCreatorIdStr = (form.createdBy?._id || form.createdBy)?.toString();
    const userIdStr = (req.user._id)?.toString();

    // Check permissions: Non-admin/superadmin can only delete if creator or granted permission
    if (!isAdmin && !isSuperAdmin) {
      const userPerms = req.user.permissions || [];
      const formIdStr = form._id?.toString();
      const customIdStr = form.id?.toString();
      const isCreator = formCreatorIdStr && formCreatorIdStr === userIdStr;
      const hasDeletePerm = isCreator ||
        userPerms.includes(`analytics:form:${formIdStr}:delete`) ||
        (customIdStr && userPerms.includes(`analytics:form:${customIdStr}:delete`)) ||
        userPerms.includes('analytics:deleteForms') ||
        userPerms.includes('analytics:manageForms') ||
        userPerms.includes('analytics:manage') ||
        userPerms.includes('analytics:delete') ||
        userPerms.includes('analytics:*');
      if (!hasDeletePerm) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to delete this form.'
        });
      }
    }

    // For admin, ensure they can only delete forms in their tenant (if both tenant IDs are present)
    if (isAdmin && !isSuperAdmin) {
      if (formTenantIdStr && userTenantIdStr && formTenantIdStr !== userTenantIdStr) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only delete forms in your organization.'
        });
      }
    }

    // Form identifiers to purge across responses and references
    const formIdentifiers = [
      form._id ? form._id.toString() : null,
      form.id ? form.id.toString() : null,
      id ? id.toString() : null
    ].filter(Boolean);

    // 1. Delete all related responses matching either questionId or formId
    await Response.deleteMany({
      $or: [
        { questionId: { $in: formIdentifiers } },
        { formId: { $in: formIdentifiers } }
      ]
    });

    // 2. Unlink this form from any parent form's childForms array
    await Form.updateMany(
      {},
      { $pull: { childForms: { formId: { $in: formIdentifiers } } } }
    );

    // 3. If this was a parent form, unlink all child forms that pointed to it
    await Form.updateMany(
      { parentFormId: { $in: formIdentifiers } },
      { $unset: { parentFormId: 1, parentFormTitle: 1 } }
    );

    // 4. Delete form using the form's _id (MongoDB ObjectId)
    await Form.findByIdAndDelete(form._id);

    res.json({
      success: true,
      message: 'Form and related responses deleted successfully'
    });

  } catch (error) {
    console.error('Delete form error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateFormVisibility = async (req, res) => {
  try {
    const { id } = req.params;
    const { isVisible } = req.body;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    // For admin, ensure they can only modify forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify forms in your organization.'
      });
    }

    form.isVisible = isVisible;
    await form.save();

    res.json({
      success: true,
      message: `Form ${isVisible ? 'published' : 'unpublished'} successfully`,
      data: { form }
    });

  } catch (error) {
    console.error('Update form visibility error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateFormLocationEnabled = async (req, res) => {
  try {
    const { id } = req.params;
    const { locationEnabled } = req.body;

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (typeof locationEnabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request. locationEnabled must be a boolean.'
      });
    }

    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify forms in your organization.'
      });
    }

    form.locationEnabled = locationEnabled;
    await form.save();

    res.json({
      success: true,
      message: `Form location ${locationEnabled ? 'enabled' : 'disabled'} successfully`,
      data: { form }
    });

  } catch (error) {
    console.error('Update form location toggle error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFormLocationEnabled = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view your own forms.'
      });
    }

    // For admin, ensure they can only view forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view forms in your organization.'
      });
    }

    res.json({
      success: true,
      data: {
        locationEnabled: form.locationEnabled || false
      }
    });

  } catch (error) {
    console.error('Get form location status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateFormActiveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    // For admin, ensure they can only modify forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify forms in your organization.'
      });
    }

    form.isActive = isActive;
    await form.save();

    res.json({
      success: true,
      message: `Form ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: { form }
    });

  } catch (error) {
    console.error('Update form active status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateFormViewType = async (req, res) => {
  try {
    const { id } = req.params;
    const { viewType } = req.body;

    console.log(`[updateFormViewType] Attempting to update form ${id} to viewType: ${viewType}`);

    if (!['section-wise', 'question-wise'].includes(viewType)) {
      console.log(`[updateFormViewType] Invalid viewType: ${viewType}`);
      return res.status(400).json({
        success: false,
        message: 'Invalid view type. Must be "section-wise" or "question-wise".'
      });
    }

    const form = await findFormByIdentifier(id);

    if (!form) {
      console.log(`[updateFormViewType] Form not found: ${id}`);
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    // For admin, ensure they can only modify forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify forms in your organization.'
      });
    }

    form.viewType = viewType;
    await form.save();

    res.json({
      success: true,
      message: `Form view type updated to ${viewType} successfully`,
      data: { form }
    });

  } catch (error) {
    console.error('Update form view type error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const duplicateForm = async (req, res) => {
  try {
    const { id } = req.params;

    // Use the helper function to find form by either custom id or MongoDB _id
    const originalForm = await findFormByIdentifier(id);

    if (!originalForm) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check duplicate permissions for non-admin
    const isSuperAdmin = req.user.role === 'superadmin';
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !isSuperAdmin) {
      const userPerms = req.user.permissions || [];
      const formIdStr = originalForm._id?.toString();
      const customIdStr = originalForm.id?.toString();
      const formCreatorIdStr = (originalForm.createdBy?._id || originalForm.createdBy)?.toString();
      const userIdStr = (req.user._id)?.toString();
      const isCreator = formCreatorIdStr && formCreatorIdStr === userIdStr;
      const hasDupPerm = isCreator ||
        userPerms.includes(`analytics:form:${formIdStr}:duplicate`) ||
        (customIdStr && userPerms.includes(`analytics:form:${customIdStr}:duplicate`)) ||
        userPerms.includes(`analytics:form:${formIdStr}`) ||
        userPerms.includes('analytics:duplicateForms') ||
        userPerms.includes('analytics:manageForms') ||
        userPerms.includes('analytics:manage') ||
        userPerms.includes('analytics:duplicate') ||
        userPerms.includes('analytics:*');
      if (!hasDupPerm) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to duplicate this form.'
        });
      }
    }

    // Create duplicate
    const duplicateData = originalForm.toObject();
    delete duplicateData._id;
    delete duplicateData.__v;

    duplicateData.id = uuidv4();
    duplicateData.title = `${duplicateData.title} (Copy)`;
    duplicateData.isVisible = false;
    duplicateData.createdBy = req.user._id;
    // Keep the same tenantId as the original form (admin can only duplicate their own tenant's forms)
    duplicateData.tenantId = originalForm.tenantId;
    duplicateData.createdAt = new Date();
    duplicateData.updatedAt = new Date();

    const duplicateForm = new Form(duplicateData);
    await duplicateForm.save();

    res.status(201).json({
      success: true,
      message: 'Form duplicated successfully',
      data: { form: duplicateForm }
    });

  } catch (error) {
    console.error('Duplicate form error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFormAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '30d' } = req.query;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Calculate date range
    const now = new Date();
    let startDate;

    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // Get responses for analytics (exclude partial submissions)
    const responses = await Response.find({
      questionId: id,
      createdAt: { $gte: startDate },
      isSectionSubmit: { $ne: true }
    }).sort({ createdAt: 1 });

    // Calculate analytics
    const totalResponses = responses.length;
    const averageResponseTime = responses.length > 0
      ? responses.reduce((acc, curr, index) => {
        if (index === 0) return 0;
        return acc + (new Date(curr.createdAt) - new Date(responses[index - 1].createdAt));
      }, 0) / (responses.length - 1)
      : 0;

    // Group responses by day
    const dailyResponses = responses.reduce((acc, response) => {
      const date = new Date(response.createdAt).toISOString().split('T')[0];
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {});

    // Status distribution
    const statusDistribution = responses.reduce((acc, response) => {
      acc[response.status] = (acc[response.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalResponses,
        averageResponseTime: Math.round(averageResponseTime / (1000 * 60)), // in minutes
        dailyResponses,
        statusDistribution,
        period,
        form: {
          id: form.id,
          title: form.title,
          createdAt: form.createdAt
        }
      }
    });

  } catch (error) {
    console.error('Get form analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// New endpoint for creating forms with follow-up question configuration
export const createFormWithFollowUp = async (req, res) => {
  try {
    const {
      title,
      description,
      logoUrl,
      imageUrl,
      options = ['Option A', 'Option B', 'Option C', 'Option D'],
      followUpConfig = {
        'Option A': { hasFollowUp: true, required: true },
        'Option B': { hasFollowUp: false, required: false },
        'Option C': { hasFollowUp: false, required: false },
        'Option D': { hasFollowUp: true, required: true }
      }
    } = req.body;

    const formId = uuidv4();

    // Create main question with 4 options
    const mainQuestion = {
      id: `main-${uuidv4()}`,
      text: title,
      type: 'radio',
      required: true,
      options: options,
      description: description
    };

    // Create follow-up questions for options that need them
    const followUpQuestions = [];

    options.forEach((option, index) => {
      const config = followUpConfig[option];
      if (config && config.hasFollowUp) {
        followUpQuestions.push({
          id: `followup-${option.toLowerCase().replace(/\s+/g, '-')}-${uuidv4()}`,
          text: `Please provide additional details for ${option}:`,
          type: 'paragraph',
          required: config.required,
          showWhen: {
            questionId: mainQuestion.id,
            value: option
          },
          parentId: mainQuestion.id,
          description: `This follow-up question is ${config.required ? 'mandatory' : 'optional'} for ${option}`
        });
      }
    });

    const formData = {
      id: formId,
      title,
      description,
      logoUrl,
      imageUrl,
      sections: [{
        id: `section-${uuidv4()}`,
        title: 'Main Section',
        description: 'Please select one option and provide follow-up details if required',
        questions: [mainQuestion, ...followUpQuestions]
      }],
      followUpQuestions,
      isVisible: false,
      createdBy: req.user._id,
      permissions: {
        canRespond: ['all'],
        canViewResponses: [req.user.role],
        canEdit: [req.user.role],
        canAddFollowUp: [req.user.role],
        canDelete: [req.user.role]
      }
    };

    const form = new Form(formData);
    await form.save();

    res.status(201).json({
      success: true,
      message: 'Form with follow-up questions created successfully',
      data: {
        form,
        followUpConfig
      }
    });

  } catch (error) {
    console.error('Create form with follow-up error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Form with this ID already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update follow-up question configuration
export const updateFollowUpConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const { followUpConfig } = req.body;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check permissions
    if (form.createdBy && req.user._id && form.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    // For admin, ensure they can only modify forms in their tenant
    if (req.user.role === 'admin' && form.tenantId && req.user.tenantId && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify forms in your organization.'
      });
    }

    // Update follow-up questions based on new configuration
    const updatedFollowUpQuestions = [];

    if (form.sections.length > 0 && form.sections[0].questions.length > 0) {
      const mainQuestion = form.sections[0].questions[0];

      if (mainQuestion.options) {
        mainQuestion.options.forEach(option => {
          const config = followUpConfig[option];
          if (config && config.hasFollowUp) {
            // Find existing follow-up question or create new one
            const existingFollowUp = form.followUpQuestions.find(
              fq => fq.showWhen && fq.showWhen.value === option
            );

            if (existingFollowUp) {
              existingFollowUp.required = config.required;
              existingFollowUp.description = `This follow-up question is ${config.required ? 'mandatory' : 'optional'} for ${option}`;
              updatedFollowUpQuestions.push(existingFollowUp);
            } else {
              updatedFollowUpQuestions.push({
                id: `followup-${option.toLowerCase().replace(/\s+/g, '-')}-${uuidv4()}`,
                text: `Please provide additional details for ${option}:`,
                type: 'paragraph',
                required: config.required,
                showWhen: {
                  questionId: mainQuestion.id,
                  value: option
                },
                parentId: mainQuestion.id,
                description: `This follow-up question is ${config.required ? 'mandatory' : 'optional'} for ${option}`
              });
            }
          }
        });
      }
    }

    form.followUpQuestions = updatedFollowUpQuestions;
    if (form.sections.length > 0) {
      form.sections[0].questions = [
        form.sections[0].questions[0], // Keep main question
        ...updatedFollowUpQuestions
      ];
    }

    await form.save();

    res.json({
      success: true,
      message: 'Follow-up configuration updated successfully',
      data: {
        form,
        followUpConfig
      }
    });

  } catch (error) {
    console.error('Update follow-up config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get follow-up configuration for a form
export const getFollowUpConfig = async (req, res) => {
  try {
    const { id } = req.params;

    // Use the helper function to find form by either custom id or MongoDB _id
    const form = await findFormByIdentifier(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    const followUpConfig = {};

    if (form.sections.length > 0 && form.sections[0].questions.length > 0) {
      const mainQuestion = form.sections[0].questions[0];

      if (mainQuestion.options) {
        mainQuestion.options.forEach(option => {
          const followUpQuestion = form.followUpQuestions.find(
            fq => fq.showWhen && fq.showWhen.value === option
          );

          followUpConfig[option] = {
            hasFollowUp: !!followUpQuestion,
            required: followUpQuestion ? followUpQuestion.required : false
          };
        });
      }
    }

    res.json({
      success: true,
      data: {
        formId: form.id,
        title: form.title,
        followUpConfig
      }
    });

  } catch (error) {
    console.error('Get follow-up config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Link child form to parent form
export const linkChildForm = async (req, res) => {
  try {
    const { id } = req.params; // Parent form ID
    const { childFormId } = req.body;

    if (!childFormId) {
      return res.status(400).json({
        success: false,
        message: 'childFormId is required'
      });
    }

    // Find parent form
    const parentForm = await findFormByIdentifier(id);
    if (!parentForm) {
      return res.status(404).json({
        success: false,
        message: 'Parent form not found'
      });
    }

    // Find child form
    const childForm = await findFormByIdentifier(childFormId);
    if (!childForm) {
      return res.status(404).json({
        success: false,
        message: 'Child form not found'
      });
    }

    // Check if forms belong to the same tenant
    if (parentForm.tenantId.toString() !== childForm.tenantId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Parent and child forms must belong to the same organization'
      });
    }

    // Check permissions
    if (parentForm.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    // Initialize childForms array if it doesn't exist
    if (!parentForm.childForms) {
      parentForm.childForms = [];
    }

    // Check if child form is already linked
    const existingLink = parentForm.childForms.find(
      cf => cf.formId === childForm.id
    );

    if (existingLink) {
      return res.status(400).json({
        success: false,
        message: 'This form is already linked as a child form'
      });
    }

    // Add child form
    const order = parentForm.childForms.length;
    parentForm.childForms.push({
      formId: childForm.id,
      formTitle: childForm.title,
      order
    });

    // Also set parentFormId on child form for bidirectional consistency
    childForm.parentFormId = parentForm.id || parentForm._id.toString();

    await Promise.all([parentForm.save(), childForm.save()]);

    res.json({
      success: true,
      message: 'Child form linked successfully',
      data: {
        parentForm,
        childForm: {
          formId: childForm.id,
          formTitle: childForm.title,
          order
        }
      }
    });

  } catch (error) {
    console.error('Link child form error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Unlink child form from parent form
export const unlinkChildForm = async (req, res) => {
  try {
    const { id, childFormId } = req.params;

    const parentForm = await findFormByIdentifier(id);
    if (!parentForm) {
      return res.status(404).json({
        success: false,
        message: 'Parent form not found'
      });
    }

    // Check permissions
    if (parentForm.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    if (!parentForm.childForms || parentForm.childForms.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No child forms linked to this parent form'
      });
    }

    const initialLength = parentForm.childForms.length;
    parentForm.childForms = parentForm.childForms.filter(
      cf => cf.formId !== childFormId
    );

    if (parentForm.childForms.length === initialLength) {
      return res.status(404).json({
        success: false,
        message: 'Child form not found in parent form'
      });
    }

    // Reorder remaining child forms
    parentForm.childForms.forEach((cf, index) => {
      cf.order = index;
    });

    await parentForm.save();

    // Also clear parentFormId on child form if it points to this parent
    try {
      const childForm = await findFormByIdentifier(childFormId);
      if (childForm && (childForm.parentFormId === parentForm.id || childForm.parentFormId === parentForm._id.toString())) {
        childForm.parentFormId = null;
        await childForm.save();
      }
    } catch (childErr) {
      console.warn('Failed to clear child parentFormId:', childErr);
    }

    res.json({
      success: true,
      message: 'Child form unlinked successfully',
      data: { parentForm }
    });

  } catch (error) {
    console.error('Unlink child form error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get child forms for a parent form
export const getChildForms = async (req, res) => {
  try {
    const { id } = req.params;

    const parentForm = await findFormByIdentifier(id);
    if (!parentForm) {
      return res.status(404).json({
        success: false,
        message: 'Parent form not found'
      });
    }

    // Get full details of child forms
    const childFormDetails = [];
    if (parentForm.childForms && parentForm.childForms.length > 0) {
      for (const childRef of parentForm.childForms) {
        const childForm = await findFormByIdentifier(childRef.formId);
        if (childForm) {
          const cIds = [childForm.id, childForm._id?.toString()].filter(Boolean);
          const cMatchIds = [];
          cIds.forEach(cid => {
            cMatchIds.push(cid);
            if (mongoose.Types.ObjectId.isValid(cid)) cMatchIds.push(new mongoose.Types.ObjectId(cid));
          });
          const cCount = await Response.countDocuments({
            $or: [
              { questionId: { $in: cMatchIds } },
              { formId: { $in: cMatchIds } }
            ],
            isSectionSubmit: { $ne: true }
          });

          childFormDetails.push({
            id: childForm.id,
            _id: childForm._id,
            title: childForm.title,
            description: childForm.description,
            isVisible: childForm.isVisible,
            isActive: childForm.isActive,
            order: childRef.order,
            responseCount: cCount
          });
        }
      }
    }

    // Sort by order
    childFormDetails.sort((a, b) => a.order - b.order);

    res.json({
      success: true,
      data: {
        parentFormId: parentForm.id,
        parentFormTitle: parentForm.title,
        childForms: childFormDetails
      }
    });

  } catch (error) {
    console.error('Get child forms error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Reorder child forms
export const reorderChildForms = async (req, res) => {
  try {
    const { id } = req.params;
    const { childFormOrder } = req.body; // Array of formIds in desired order

    if (!Array.isArray(childFormOrder)) {
      return res.status(400).json({
        success: false,
        message: 'childFormOrder must be an array'
      });
    }

    const parentForm = await findFormByIdentifier(id);
    if (!parentForm) {
      return res.status(404).json({
        success: false,
        message: 'Parent form not found'
      });
    }

    // Check permissions
    if (parentForm.createdBy.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only modify your own forms.'
      });
    }

    if (!parentForm.childForms || parentForm.childForms.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No child forms linked to this parent form'
      });
    }

    // Create a map of formId to child form data
    const childFormsMap = new Map();
    parentForm.childForms.forEach(cf => {
      childFormsMap.set(cf.formId, cf);
    });

    // Reorder based on provided array
    const reorderedChildForms = [];
    childFormOrder.forEach((formId, index) => {
      const childForm = childFormsMap.get(formId);
      if (childForm) {
        childForm.order = index;
        reorderedChildForms.push(childForm);
      }
    });

    parentForm.childForms = reorderedChildForms;
    await parentForm.save();

    res.json({
      success: true,
      message: 'Child forms reordered successfully',
      data: { parentForm }
    });

  } catch (error) {
    console.error('Reorder child forms error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const setSectionBranching = async (req, res) => {
  try {
    const { id } = req.params;
    const { rules } = req.body;

    if (!Array.isArray(rules)) {
      return res.status(400).json({
        success: false,
        message: 'Rules must be an array'
      });
    }

    const form = await findFormByIdentifier(id);
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Validate tenant access (allow superadmin access to all)
    if (req.user.role !== 'superadmin' && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const validatedRules = rules.map(rule => ({
      questionId: rule.questionId,
      sectionId: rule.sectionId,
      optionLabel: rule.optionLabel,
      optionIndex: rule.optionIndex,
      targetSectionId: rule.targetSectionId,
      isOtherOption: rule.isOtherOption || false
    }));

    form.sectionBranching = validatedRules;
    await form.save();

    res.status(200).json({
      success: true,
      message: 'Section branching rules saved successfully',
      data: { sectionBranching: form.sectionBranching }
    });
  } catch (error) {
    console.error('Set section branching error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSectionBranching = async (req, res) => {
  try {
    const { id } = req.params;

    const form = await findFormByIdentifier(id);
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Validate tenant access (allow superadmin access to all)
    if (req.user.role !== 'superadmin' && form.tenantId.toString() !== req.user.tenantId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      data: { sectionBranching: form.sectionBranching || [] }
    });
  } catch (error) {
    console.error('Get section branching error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSectionBranchingPublic = async (req, res) => {
  try {
    const { id, tenantSlug } = req.params;

    // Fetch tenant by slug
    const Tenant = mongoose.model('Tenant');
    const tenant = await Tenant.findOne({ slug: tenantSlug });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const form = await findFormByIdentifier(id);
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check if form is visible and belongs to correct tenant
    if (!form.isVisible || form.tenantId.toString() !== tenant._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Form not accessible'
      });
    }

    res.status(200).json({
      success: true,
      data: { sectionBranching: form.sectionBranching || [] }
    });
  } catch (error) {
    console.error('Get section branching public error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Import form from simplified CSV template
export const importFormFromCSV = async (req, res) => {
  try {
    console.log('=== Import Form from CSV ===');
    console.log('User:', req.user?.email, 'Role:', req.user?.role);

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'No CSV file provided'
      });
    }

    // Determine tenantId based on user role
    let tenantId;
    if (req.user.role === 'superadmin') {
      tenantId = req.body.tenantId;
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required for superadmin'
        });
      }
    } else {
      tenantId = req.user.tenantId;
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'User does not have a tenantId assigned'
        });
      }
    }

    // Validate tenantId
    if (!mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenantId format'
      });
    }

    // Convert buffer to string
    const csvData = req.file.buffer.toString('utf-8');

    // Import the parser
    const { parseSimplifiedCSVForm, validateSubmitButtons } = await import('../utils/csvFormParser.js');

    // Parse CSV
    const formData = parseSimplifiedCSVForm(csvData, {
      id: uuidv4(),
      createdBy: req.user._id,
      tenantId: tenantId,
      isVisible: false  // Default to private
    });

    // Validate submit buttons
    const validation = validateSubmitButtons(formData);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        issues: validation.issues
      });
    }

    // Normalize all sections using global utility
    if (Array.isArray(formData.sections)) {
      formData.sections.forEach(section => {
        if (Array.isArray(section.questions)) {
          section.questions = section.questions.map(q => normalizeQuestionTypes(q));
        }
      });
    }

    // Normalize top-level follow-up questions using global utility
    if (Array.isArray(formData.followUpQuestions)) {
      formData.followUpQuestions = formData.followUpQuestions.map(q => normalizeQuestionTypes(q));
    }

    // Create form
    const form = new Form(formData);
    await form.save();

    console.log('Form imported successfully from CSV with ID:', form.id);

    // Extract unique parameters from questions (SubParam1, SubParam2)
    const parametersToCreate = new Set();
    const extractParameters = (question) => {
      if (question.subParam1) parametersToCreate.add(question.subParam1);
      if (question.subParam2) parametersToCreate.add(question.subParam2);
      if (Array.isArray(question.followUpQuestions)) {
        question.followUpQuestions.forEach(extractParameters);
      }
    };

    if (Array.isArray(formData.sections)) {
      formData.sections.forEach(section => {
        if (Array.isArray(section.questions)) {
          section.questions.forEach(extractParameters);
        }
      });
    }

    // Create parameters for this form
    const parameterPromises = Array.from(parametersToCreate).map(paramName =>
      Parameter.create({
        name: paramName,
        type: 'main',
        formId: form._id,
        tenantId: tenantId,
        createdBy: req.user._id
      }).catch(err => {
        console.warn(`Failed to create parameter "${paramName}":`, err.message);
        return null;
      })
    );

    await Promise.all(parameterPromises);
    console.log(`Created ${parametersToCreate.size} parameters for form`);

    res.status(201).json({
      success: true,
      message: 'Form imported successfully from CSV',
      data: { form }
    });

  } catch (error) {
    console.error('CSV import error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'CSV import failed'
    });
  }
};

export const getGlobalFormStats = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[DEBUG] getGlobalFormStats - formId:', id);

    const form = await findFormByIdentifier(id);

    if (!form) {
      console.log('[DEBUG] getGlobalFormStats - Form not found');
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    const formMongoId = form._id;
    const formCustomId = form.id;
    console.log('[DEBUG] getGlobalFormStats - Form found:', {
      mongoId: formMongoId.toString(),
      customId: formCustomId
    });

    const matchOrConditions = [];
    if (formCustomId) matchOrConditions.push({ questionId: formCustomId });
    if (formMongoId) {
      matchOrConditions.push({ questionId: formMongoId.toString() });
      matchOrConditions.push({ questionId: formMongoId });
    }

    console.log('[DEBUG] getGlobalFormStats - matchOrConditions:', JSON.stringify(matchOrConditions));

    const stats = await Response.aggregate([
      {
        $match: {
          $or: matchOrConditions,
          isSectionSubmit: { $ne: true }
        }
      },
      {
        $group: {
          _id: "$tenantId",
          responseCount: { $sum: 1 },
          lastResponse: { $max: "$createdAt" }
        }
      },
      {
        $lookup: {
          from: "tenants",
          localField: "_id",
          foreignField: "_id",
          as: "tenantInfo"
        }
      },
      { $unwind: { path: "$tenantInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          tenantId: "$_id",
          tenantName: { $ifNull: ["$tenantInfo.name", "Unknown"] },
          companyName: { $ifNull: ["$tenantInfo.companyName", "Unknown"] },
          responseCount: 1,
          lastResponse: 1,
          _id: 0
        }
      },
      { $sort: { responseCount: -1 } }
    ]);

    console.log(`[DEBUG] getGlobalFormStats - Aggregation complete, found ${stats.length} stats`);

    res.json({
      success: true,
      data: {
        stats: stats || []
      }
    });
  } catch (error) {
    console.error('[ERROR] getGlobalFormStats:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

// Start a form session for time tracking
export const startFormSession = async (req, res) => {
  try {
    const { id } = req.params;
    const { formTitle } = req.body;

    const Form = mongoose.model('Form');
    const FormSession = mongoose.model('FormSession');

    // Find the form - use 'id' field which is a custom UUID
    // Check if it's a valid ObjectId first
    let query = { id: id };
    if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) {
      query = { $or: [{ id: id }, { _id: id }] };
    }
    const form = await Form.findOne(query);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Get tenant ID
    const tenantId = req.user?.tenantId || form.tenantId;

    // Create a new session
    const sessionId = uuidv4();
    const startedAt = new Date();

    const formSession = new FormSession({
      sessionId,
      formId: id,
      tenantId,
      userId: req.user?._id,
      startedAt,
      status: 'in-progress',
      lastActivityAt: startedAt
    });

    await formSession.save();

    console.log(`[TIME TRACKING] Form session started: ${sessionId} for form ${id}`);

    res.json({
      success: true,
      sessionId,
      startedAt: startedAt.toISOString()
    });
  } catch (error) {
    console.error('[ERROR] startFormSession:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

export const submitPublicResponse = async (req, res) => {
  try {
    console.log('[PUBLIC SUBMIT] === DEBUG START ===');
    console.log('[PUBLIC SUBMIT] req.user:', req.user);
    console.log('[PUBLIC SUBMIT] req.user?._id:', req.user?._id);
    console.log('[PUBLIC SUBMIT] req.user?.role:', req.user?.role);
    console.log('[PUBLIC SUBMIT] auth header:', !!req.header('Authorization'));

    const { id } = req.params;
    const {
      inviteId,
      answers,
      location,
      isSectionSubmit,
      sectionIndex,
      submissionMetadata,
      startedAt,
      completedAt,
      sessionId
    } = req.body;

    console.log("=".repeat(50));
    console.log("📝 PUBLIC SUBMISSION DEBUG");
    console.log("=".repeat(50));
    console.log("Form ID:", id);
    console.log("Invite ID:", inviteId);
    console.log("Is Section Submit:", isSectionSubmit);
    console.log("Section Index:", sectionIndex);
    console.log("Answers keys:", Object.keys(answers || {}));
    console.log("Location:", location);
    console.log("Metadata:", submissionMetadata);

    // Import models
    const FormInvite = mongoose.model('FormInvite');
    const Form = mongoose.model('Form');

    let invite = null;

    if (inviteId) {
      console.log("🔍 Searching for invite with:");
      console.log("  formId:", id);
      console.log("  inviteId:", inviteId);

      // First, find the invite (don't filter by status yet)
      invite = await FormInvite.findOne({
        formId: id,
        inviteId: inviteId
      });

      console.log("📊 Invite found:", invite ? "YES" : "NO");

      if (invite) {
        console.log("  Invite details:");
        console.log("    - Status:", invite.status);
        console.log("    - Email:", invite.email);
        console.log("    - Created:", invite.createdAt);
        console.log("    - Sent:", invite.sentAt);
        console.log("    - Responded:", invite.respondedAt);
      } else {
        // Check if any invites exist for this form
        const allInvites = await FormInvite.find({ formId: id }).limit(5);
        console.log(`📋 Total invites for this form: ${allInvites.length}`);
        if (allInvites.length > 0) {
          console.log("Sample invite IDs in DB:");
          allInvites.forEach((inv, idx) => {
            console.log(`  ${idx + 1}. ${inv.inviteId} (${inv.status})`);
          });
        }
      }

      if (!invite) {
        return res.status(403).json({
          success: false,
          message: 'Invalid invite'
        });
      }

      // Check if already responded
      if (invite.status === 'responded' && !isSectionSubmit) {
        console.log("⚠️ Invite already responded at:", invite.respondedAt);
        return res.status(409).json({
          success: false,
          message: 'ALREADY_SUBMITTED',
          data: {
            email: invite.email,
            submittedAt: invite.respondedAt
          }
        });
      }
    } else {
      console.log("ℹ️ No inviteId provided - allowing public/preview submission");
    }

    // Get the form
    const form = await Form.findOne({ id: id });
    console.log("📋 Form found:", form ? "YES" : "NO");

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    console.log("✅ All validations passed, creating response...");

    let submissionTimeSpent = 0;
    let formSession = null;
    let actualStartedAt = startedAt ? new Date(startedAt) : null;
    let actualCompletedAt = completedAt ? new Date(completedAt) : new Date();

    // Calculate time if we have start time
    if (actualStartedAt) {
      submissionTimeSpent = Math.floor((actualCompletedAt - actualStartedAt) / 1000);
    }

    // Try to find FormSession if we have sessionId
    if (sessionId) {
      try {
        const FormSession = mongoose.model('FormSession');
        formSession = await FormSession.findOne({ sessionId });

        if (formSession) {
          // Use session data for more accurate timing
          if (formSession.startedAt) {
            actualStartedAt = formSession.startedAt;
            actualCompletedAt = new Date();
            submissionTimeSpent = Math.floor((actualCompletedAt - formSession.startedAt) / 1000);
          }

          // Update session as completed (only for final submission, not partial)
          if (!isSectionSubmit) {
            formSession.completedAt = actualCompletedAt;
            formSession.timeSpent = submissionTimeSpent;
            formSession.status = 'completed';
            formSession.answers = answers;
            await formSession.save();
            console.log(`[TIME TRACKING] Public Session ${sessionId} completed in ${submissionTimeSpent} seconds`);
          } else {
            // For partial submissions, just update last activity
            formSession.lastActivityAt = actualCompletedAt;
            await formSession.save();
            console.log(`[TIME TRACKING] Partial public submission for session ${sessionId}`);
          }
        }
      } catch (err) {
        console.error('Error finding FormSession:', err);
      }
    }

    // ========== DUPLICATE SUBMISSION PREVENTION ==========
    const targetSessionId = sessionId || formSession?.sessionId;
    if (targetSessionId && !isSectionSubmit) {
      const Response = mongoose.model('Response');
      const existingSessionResponse = await Response.findOne({
        $or: [
          { questionId: id },
          { formId: id }
        ],
        $or: [
          { sessionId: targetSessionId },
          { 'submissionMetadata.sessionId': targetSessionId }
        ]
      });
      if (existingSessionResponse) {
        console.log(`[PUBLIC SUBMIT] Duplicate submission blocked for sessionId: ${targetSessionId}`);
        return res.status(200).json({
          success: true,
          message: 'Response already submitted successfully',
          data: { response: existingSessionResponse }
        });
      }
    }

    // Create the response - include createdBy if user is authenticated
    const responseData = {
      id: uuidv4(),
      questionId: id,
      tenantId: form.tenantId,
      formId: id,
      inviteId: inviteId,
      answers: answers,
      location: location,
      submissionMetadata: {
        ...submissionMetadata,
        timeSpent: submissionTimeSpent,
        sessionId: sessionId || formSession?.sessionId || null,
        startedAt: actualStartedAt,
        completedAt: actualCompletedAt,
        questionTimings: formSession?.questionTimings,
        sectionTimings: formSession?.sectionTimings
      },
      timeSpent: submissionTimeSpent,
      sessionId: sessionId || formSession?.sessionId || null,
      startedAt: actualStartedAt,
      completedAt: actualCompletedAt,
      questionTimings: formSession?.questionTimings || [],
      isSectionSubmit: !!isSectionSubmit,
      sectionIndex: sectionIndex || null,
      submittedAt: new Date(),
      createdAt: new Date()
    };

    // If user is authenticated (not a public submission), set createdBy
    if (req.user && req.user._id) {
      responseData.createdBy = req.user._id;
      console.log('[PUBLIC SUBMIT] Setting createdBy to user ID:', req.user._id);
    }

    const response = new Response(responseData);

    await response.save();
    console.log("✅ Response saved with ID:", response._id);

    // Update invite status only on final submission (if invite exists)
    if (!isSectionSubmit && invite) {
      invite.status = 'responded';
      invite.respondedAt = new Date();
      await invite.save();
      console.log("✅ Invite updated to responded");
    } else if (isSectionSubmit) {
      console.log("✅ Partial section response saved");
    } else {
      console.log("✅ Response saved (no invite to update)");
    }

    res.json({
      success: true,
      message: 'SUCCESS',
      data: {
        responseId: response._id,
        inviteId: inviteId || null
      }
    });

  } catch (error) {
    console.error('❌ Error in public submission:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit form',
      error: error.message
    });
  }
};