import File from '../models/File.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { uploadToCloudinary, deleteFromCloudinary } from '../services/cloudinaryService.js';
import axios from 'axios';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to proxy external files to avoid CORS issues in frontend
export const proxyFile = async (req, res) => {
  try {
    let { url } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL is required'
      });
    }

    // Basic security check
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Invalid URL'
      });
    }

    // Handle Google Drive links - convert view links to download links
    if (url.includes('drive.google.com')) {
      const fileIdMatch = url.match(/\/d\/([^/]+)/);
      if (fileIdMatch && fileIdMatch[1]) {
        url = `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
      }
    }

    console.log(`[PROXY] Fetching: ${url}`);

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 60000, // 60 seconds
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false })
    });

    // Pass along content-type and other useful headers
    const contentType = response.headers['content-type'];
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Ensure CORS is allowed for the proxy response itself

    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy file error:', error.message);
    
    // If axios failed with a response, we might want to pass that status along
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        message: `External server returned error: ${error.response.statusText}`,
        url: url
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to proxy file',
      error: error.message
    });
  }
};

export const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { associatedType: bodyAssociatedType, associatedId: bodyAssociatedId } = req.body;
    const { associatedType: queryAssociatedType, associatedId: queryAssociatedId } = req.query;

    const normalizeValue = (value) => {
      if (!value) {
        return undefined;
      }
      return Array.isArray(value) ? value[0] : value;
    };

    const rawAssociatedType = (normalizeValue(bodyAssociatedType) || normalizeValue(queryAssociatedType) || 'form').toString().toLowerCase();
    const typeMap = {
      form: 'form',
      response: 'response',
      profile: 'profile',
      logo: 'logo',
      tenant_logo: 'logo',
      general: 'form'
    };
    const associatedType = typeMap[rawAssociatedType] || 'form';
    const associatedIdentifier = normalizeValue(bodyAssociatedId) || normalizeValue(queryAssociatedId);

    // Upload to Cloudinary
    const folder = `focus_forms/${associatedType}`;
    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    
    const cloudinaryResult = await uploadToCloudinary(req.file.buffer, filename, folder);

    const associatedWith = { type: associatedType };
    if (associatedIdentifier) {
      associatedWith.id = associatedIdentifier;
    }

    const fileRecord = new File({
      filename: req.file.originalname,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      cloudinaryPublicId: cloudinaryResult.public_id,
      cloudinaryUrl: cloudinaryResult.secure_url,
      url: cloudinaryResult.secure_url,
      uploadedBy: req.user ? req.user._id : null,
      associatedWith,
      isPublic: true
    });

    await fileRecord.save();

    const fileData = fileRecord.toObject();

    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        file: fileData,
        url: fileData.url
      }
    });

  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

export const getFile = async (req, res) => {
  try {
    const { filename } = req.params;

    // Check if filename is a valid ObjectId (database file ID)
    const mongoose = (await import('mongoose')).default;
    let fileRecord;

    if (mongoose.Types.ObjectId.isValid(filename)) {
      // If it's an ObjectId, find by _id
      fileRecord = await File.findById(filename);
    } else {
      // Otherwise, find by filename
      fileRecord = await File.findOne({ filename });
    }

    if (!fileRecord) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    if (fileRecord.cloudinaryUrl) {
      // Redirect to Cloudinary URL
      return res.redirect(fileRecord.cloudinaryUrl);
    }

    if (fileRecord.gridfsId) {
      // Stream from GridFS
      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
      res.setHeader('Content-Type', fileRecord.mimetype || 'application/octet-stream');
      
      const downloadStream = bucket.openDownloadStream(fileRecord.gridfsId);
      downloadStream.on('error', (err) => {
        console.error('GridFS download error:', err);
        if (!res.headersSent) {
          res.status(404).send('File not found in GridFS');
        }
      });
      return downloadStream.pipe(res);
    }

    return res.status(404).json({
      success: false,
      message: 'File contents not found'
    });

  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteFile = async (req, res) => {
  try {
    const { id } = req.params;

    const fileRecord = await File.findById(id);

    if (!fileRecord) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Check permissions
    const isOwner = fileRecord.uploadedBy && fileRecord.uploadedBy.toString() === req.user._id.toString();

    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only delete your own files.'
      });
    }

    // Delete file from Cloudinary
    if (fileRecord.cloudinaryPublicId) {
      try {
        await deleteFromCloudinary(fileRecord.cloudinaryPublicId);
      } catch (cloudinaryError) {
        console.warn('Cloudinary delete warning:', cloudinaryError);
        // Continue with database deletion even if Cloudinary delete fails
      }
    }

    // Delete record from database
    await File.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });

  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFilesByUser = async (req, res) => {
  try {
    const { page = 1, limit = 10, type } = req.query;
    
    const query = { uploadedBy: req.user._id };
    
    if (type) {
      query['associatedWith.type'] = type;
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    };

    const files = await File.find(query)
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await File.countDocuments(query);

    res.json({
      success: true,
      data: {
        files,
        pagination: {
          currentPage: options.page,
          totalPages: Math.ceil(total / options.limit),
          totalFiles: total,
          hasNextPage: options.page < Math.ceil(total / options.limit),
          hasPrevPage: options.page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get files by user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getFileInfo = async (req, res) => {
  try {
    const { id } = req.params;

    const fileRecord = await File.findById(id)
      .populate('uploadedBy', 'username firstName lastName email');

    if (!fileRecord) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    res.json({
      success: true,
      data: { file: fileRecord }
    });

  } catch (error) {
    console.error('Get file info error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};