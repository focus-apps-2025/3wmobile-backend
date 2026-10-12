export const validateLogin = (req, res, next) => {
  const { username, email, password } = req.body;
  
  const errors = [];
  
  // Accept either username or email
  const loginField = username || email;
  if (!loginField) {
    errors.push('Username or email is required');
  } else if (loginField.trim().length < 3) {
    errors.push('Username or email must be at least 3 characters long');
  }
  
  if (!password) {
    errors.push('Password is required');
  } else if (password.length < 6) {
    errors.push('Password must be at least 6 characters long');
  }
  
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors
    });
  }
  
  next();
};

export const validateUserCreation = (req, res, next) => {
  const { username, email, password, firstName, lastName, role } = req.body;
  
  const errors = [];
  
  if (!username) {
    errors.push('Username is required');
  } else if (username.trim().length < 3) {
    errors.push('Username must be at least 3 characters long');
  }
  
  if (!email) {
    errors.push('Email is required');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Valid email is required');
  }
  
  if (!password) {
    errors.push('Password is required');
  } else if (password.length < 6) {
    errors.push('Password must be at least 6 characters long');
  }
  
  if (!firstName || firstName.trim().length === 0) {
    errors.push('First name is required');
  }
  
  if (!lastName || lastName.trim().length === 0) {
    errors.push('Last name is required');
  }
  
if (!role) {
      errors.push('Role is required');
    } else if (!['admin', 'subadmin', 'teacher', 'student', 'staff', 'inspector'].includes(role)) {
      errors.push('Role must be one of: admin, subadmin, teacher, student, staff, inspector');
    }

  if (req.body.permissions !== undefined) {
    if (!Array.isArray(req.body.permissions)) {
      errors.push('Permissions must be an array of strings');
    } else if (!req.body.permissions.every((permission) => typeof permission === 'string')) {
      errors.push('Permissions must be an array of strings');
    }
  }
  
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors
    });
  }
  
  next();
};