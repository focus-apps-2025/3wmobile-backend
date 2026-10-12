import Role from '../models/Permission.js';
import User from '../models/User.js';
import { v4 as uuidv4 } from 'uuid';

export const createRole = async (req, res) => {
  try {
    const { name, description, permissions, formPermissions, canCreateForms } = req.body;

    // Check if role name already exists
    const existingRole = await Role.findOne({ name });
    if (existingRole) {
      return res.status(400).json({
        success: false,
        message: 'Role with this name already exists'
      });
    }

    const role = new Role({
      id: uuidv4(),
      name,
      description,
      permissions: permissions || [],
      formPermissions: formPermissions || [],
      canCreateForms: canCreateForms || false,
      createdBy: req.user._id,
      tenantId: req.user.tenantId
    });

    await role.save();

    res.status(201).json({
      success: true,
      message: 'Role created successfully',
      data: { role }
    });

  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAllRoles = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, includeSystem = true } = req.query;
    
    const baseQuery = req.user.role === 'superadmin'
      ? {}
      : { tenantId: req.user.tenantId };

    const query = { ...baseQuery };

    // Search by name or description
    if (search) {
      query.$and = [
        {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } }
          ]
        }
      ];
    }
    
    // Include/exclude system roles
    if (includeSystem === 'false') {
      if (!query.$and) {
        query.$and = [];
      }
      query.$and.push({ isSystem: { $ne: true } });
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: {
        path: 'createdBy',
        select: 'username firstName lastName'
      }
    };

    const roles = await Role.find(query)
      .populate(options.populate.path, options.populate.select)
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await Role.countDocuments(query);

    res.json({
      success: true,
      data: {
        roles,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalRoles: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get all roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getRoleById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    const role = await Role.findOne(query)
      .populate('createdBy', 'username firstName lastName');

    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    res.json({
      success: true,
      data: { role }
    });

  } catch (error) {
    console.error('Get role by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions, formPermissions, canCreateForms } = req.body;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };
    const role = await Role.findOne(query);

    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Check if it's a system role
    if (role.isSystem) {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify system roles'
      });
    }

    // Check if name already exists (excluding current role)
    if (name && name !== role.name) {
      const existingRole = await Role.findOne({ name, id: { $ne: id } });
      if (existingRole) {
        return res.status(400).json({
          success: false,
          message: 'Role with this name already exists'
        });
      }
      role.name = name;
    }

    // Update fields
    if (description !== undefined) role.description = description;
    if (permissions) role.permissions = permissions;
    if (formPermissions) role.formPermissions = formPermissions;
    if (typeof canCreateForms === 'boolean') role.canCreateForms = canCreateForms;

    await role.save();

    res.json({
      success: true,
      message: 'Role updated successfully',
      data: { role }
    });

  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }] }
      : { id };

    const role = await Role.findOne(query);

    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Check if it's a system role
    if (role.isSystem) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete system roles'
      });
    }

    // Check if any users are assigned this role
    const usersWithRole = await User.countDocuments({ customRole: role._id });
    if (usersWithRole > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete role. ${usersWithRole} user(s) are assigned to this role.`
      });
    }

    await Role.findOneAndDelete({ _id: role._id });

    res.json({
      success: true,
      message: 'Role deleted successfully'
    });

  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const assignRoleToUser = async (req, res) => {
  try {
    const { userId, roleId } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const role = await Role.findOne({ id: roleId });
    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    user.customRole = role._id;
    await user.save();

    await user.populate('customRole', 'id name description permissions');

    res.json({
      success: true,
      message: 'Role assigned successfully',
      data: { user }
    });

  } catch (error) {
    console.error('Assign role to user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUsersByRole = async (req, res) => {
  try {
    const { roleId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const role = await Role.findOne({ id: roleId });
    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    };

    const users = await User.find({ customRole: role._id, ...req.tenantFilter })
      .select('-password')
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await User.countDocuments({ customRole: role._id, ...req.tenantFilter });

    res.json({
      success: true,
      data: {
        users,
        role: {
          id: role.id,
          name: role.name,
          description: role.description
        },
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalUsers: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get users by role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAvailablePermissions = async (req, res) => {
  try {
    const permissions = [
      {
        id: 'create_forms',
        name: 'Create Forms',
        description: 'Can create new forms'
      },
      {
        id: 'edit_forms',
        name: 'Edit Forms',
        description: 'Can edit existing forms'
      },
      {
        id: 'delete_forms',
        name: 'Delete Forms',
        description: 'Can delete forms'
      },
      {
        id: 'view_all_responses',
        name: 'View All Responses',
        description: 'Can view responses from all forms'
      },
      {
        id: 'manage_users',
        name: 'Manage Users',
        description: 'Can create, edit, and delete users'
      },
      {
        id: 'manage_roles',
        name: 'Manage Roles',
        description: 'Can create, edit, and delete roles'
      },
      {
        id: 'view_analytics',
        name: 'View Analytics',
        description: 'Can access analytics and reports'
      },
      {
        id: 'export_data',
        name: 'Export Data',
        description: 'Can export forms and responses'
      },
      {
        id: 'system_settings',
        name: 'System Settings',
        description: 'Can access system settings and configuration'
      },
      {
        id: 'upload:create',
        name: 'Create Uploads',
        description: 'Can upload files and images'
      },
      {
        id: 'upload:delete',
        name: 'Delete Uploads',
        description: 'Can delete uploaded files'
      }
    ];

    res.json({
      success: true,
      data: { permissions }
    });

  } catch (error) {
    console.error('Get available permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};