import Profile from '../models/Profile.js';
import User from '../models/User.js';

export const getProfile = async (req, res) => {
  try {
    const userId = req.params.userId || req.user._id;

    let profile = await Profile.findOne({ userId }).populate('userId', 'username email firstName lastName role');

    if (!profile) {
      // Create profile from user data if it doesn't exist
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      profile = new Profile({
        userId: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        phone: user.mobile || '',
        settings: {
          darkMode: false,
          notifications: true,
          emailUpdates: true,
          language: 'en'
        }
      });

      await profile.save();
      await profile.populate('userId', 'username email firstName lastName role');
    }

    // Include username from the populated user data
    const profileData = profile.toObject();
    if (profile.userId && profile.userId.username) {
      profileData.username = profile.userId.username;
    }

    res.json({
      success: true,
      data: { profile: profileData }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const userId = req.params.userId || req.user._id;
    const { firstName, lastName, email, mobile, name, phone, avatar, bio, department, position, settings, username } = req.body;

    // Check if user can update this profile
    if (userId !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only update your own profile.'
      });
    }

    // Prepare user update data
    const userUpdateData = {};
    if (firstName) userUpdateData.firstName = firstName;
    if (lastName) userUpdateData.lastName = lastName;
    if (email) userUpdateData.email = email;
    if (mobile) userUpdateData.mobile = mobile;
    if (username) userUpdateData.username = username;

    // Check if email is already taken
    if (email) {
      const existingEmail = await User.findOne({
        _id: { $ne: userId },
        email: email
      });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists. Please use a different email.'
        });
      }
    }

    // Check if username is already taken
    if (username) {
      const existingUser = await User.findOne({
        _id: { $ne: userId },
        username: username
      });
      
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists. Please choose a different username.'
        });
      }
    }

    // Update User model with identity fields
    let updatedUser = await User.findByIdAndUpdate(
      userId,
      userUpdateData,
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    let profile = await Profile.findOne({ userId });

    if (!profile) {
      // Create profile if it doesn't exist
      profile = new Profile({
        userId: updatedUser._id,
        name: (firstName && lastName) ? `${firstName} ${lastName}` : name || `${updatedUser.firstName} ${updatedUser.lastName}`,
        email: email || updatedUser.email,
        phone: mobile || phone || updatedUser.mobile || '',
        avatar,
        bio,
        department,
        position,
        settings: settings || {
          darkMode: false,
          notifications: true,
          emailUpdates: true,
          language: 'en'
        }
      });
    } else {
      // Update existing profile
      if (firstName && lastName) profile.name = `${firstName} ${lastName}`;
      else if (name) profile.name = name;
      
      if (email) profile.email = email;
      if (mobile) profile.phone = mobile;
      else if (phone !== undefined) profile.phone = phone;
      
      if (avatar !== undefined) profile.avatar = avatar;
      if (bio !== undefined) profile.bio = bio;
      if (department !== undefined) profile.department = department;
      if (position !== undefined) profile.position = position;
      if (settings) {
        profile.settings = { ...profile.settings, ...settings };
      }
    }

    await profile.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { user: updatedUser.toObject() }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { settings } = req.body;

    let profile = await Profile.findOne({ userId: req.user._id });

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found'
      });
    }

    profile.settings = { ...profile.settings, ...settings };
    await profile.save();

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: { settings: profile.settings }
    });

  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    
    let profile = await Profile.findOne({ userId: req.user._id });

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found'
      });
    }

    profile.avatar = avatarUrl;
    await profile.save();

    res.json({
      success: true,
      message: 'Avatar uploaded successfully',
      data: { avatarUrl }
    });

  } catch (error) {
    console.error('Upload avatar error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};