// routes/upload.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Readable } from 'stream';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../services/cloudinaryService.js';
import { uploadToS3 } from '../services/s3Service.js';
import File from '../models/File.js';
import { authenticate, hasPermission } from '../middleware/auth.js';

const router = express.Router();

// File type validation
const ALLOWED_FILE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt'
};

const CATEGORIES = {
  avatars: { maxSize: 5 * 1024 * 1024, path: 'focus_forms/avatars/' },
  forms: { maxSize: 25 * 1024 * 1024, path: 'focus_forms/forms/' },
  templates: { maxSize: 10 * 1024 * 1024, path: 'focus_forms/templates/' },
  exports: { maxSize: 50 * 1024 * 1024, path: 'focus_forms/exports/' },
  evidence: { maxSize: 25 * 1024 * 1024, path: 'focus_forms/forms/' },
  chat: { maxSize: 25 * 1024 * 1024, path: 'focus_forms/chat/' }
};

const getS3Config = () => {
  const s3Bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME || 'ib-project';
  const s3Region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'ap-south-1';
  const cloudfrontDomain = process.env.AWS_CLOUDFRONT_DOMAIN || (process.env.CLOUDFRONT_URL ? process.env.CLOUDFRONT_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'd196xvstj956a9.cloudfront.net');

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && s3Bucket) {
    const s3Client = new S3Client({
      region: s3Region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    return { s3Client, s3Bucket, s3Region, cloudfrontDomain };
  }
  return null;
};

// Direct upload handler supporting S3/CloudFront, Cloudinary and MongoDB GridFS fallback
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const handleDirectUpload = async (req, res) => {
  try {
    const file = req.file || (req.files && (req.files.file || req.files.image || Object.values(req.files)[0]));
    if (!file) {
      console.warn('[DIRECT UPLOAD] No file in request');
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const { category = 'forms', formId, associatedId } = req.body || {};
    const targetFormId = formId || associatedId;
    const originalFilename = file.originalname || file.name || `camera_${Date.now()}.jpg`;
    const buffer = file.buffer || file.data;
    const mimetype = file.mimetype || 'image/jpeg';
    
    // 1. First try AWS S3 / CloudFront
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      try {
        console.log(`[DIRECT UPLOAD] Attempting S3 upload for ${originalFilename}...`);
        const s3Folder = (targetFormId && (category === 'forms' || category === 'form' || category === 'evidence'))
          ? `focus_forms/forms/${targetFormId}`
          : (category === 'forms' || category === 'form' || category === 'evidence' ? 'focus_forms/forms' : `focus_forms/${category}`);
        const s3Result = await uploadToS3(buffer, originalFilename, s3Folder);
        if (s3Result && (s3Result.url || s3Result.publicUrl)) {
          const finalUrl = s3Result.publicUrl || s3Result.url;
          console.log(`[DIRECT UPLOAD] S3 upload successful:`, finalUrl);
          return res.json({
            success: true,
            publicUrl: finalUrl,
            url: finalUrl,
            key: s3Result.key || s3Result.public_id,
            format: s3Result.format,
            bytes: s3Result.bytes
          });
        }
      } catch (s3Err) {
        console.warn(`[DIRECT UPLOAD] S3 upload error:`, s3Err.message);
      }
    }

    // 2. Try Cloudinary if credentials are configured
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      try {
        console.log(`[DIRECT UPLOAD] Attempting Cloudinary upload for ${originalFilename}...`);
        const result = await uploadToCloudinary(buffer, originalFilename, `focus_forms/${category}`);
        if (result && result.secure_url) {
          console.log(`[DIRECT UPLOAD] Cloudinary upload successful:`, result.secure_url);
          return res.json({
            success: true,
            publicUrl: result.secure_url,
            url: result.secure_url,
            key: result.public_id,
            format: result.format,
            bytes: result.bytes
          });
        }
      } catch (cloudErr) {
        console.warn(`[DIRECT UPLOAD] Cloudinary upload failed (${cloudErr.message}), falling back to MongoDB GridFS storage...`);
      }
    }

    // 3. Fallback: Save directly to MongoDB GridFS
    console.log(`[DIRECT UPLOAD] Storing file ${originalFilename} in MongoDB GridFS...`);
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    const uniqueFilename = `${Date.now()}_${originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    
    const uploadStream = bucket.openUploadStream(uniqueFilename, {
      contentType: mimetype,
      metadata: { originalName: originalFilename, category }
    });

    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);

    await new Promise((resolve, reject) => {
      readable.pipe(uploadStream)
        .on('error', reject)
        .on('finish', resolve);
    });

    // Save File record in DB
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}/api`;

    const fileRecord = new File({
      filename: uniqueFilename,
      originalName: originalFilename,
      mimetype: mimetype,
      size: buffer.length,
      gridfsId: uploadStream.id,
      url: `${baseUrl}/files/${uploadStream.id}`,
      associatedWith: { type: 'form', id: category },
      isPublic: true
    });
    await fileRecord.save();

    const fileUrl = `${baseUrl}/files/${fileRecord._id}`;
    console.log(`[DIRECT UPLOAD] Stored in MongoDB GridFS successfully. Access URL: ${fileUrl}`);

    return res.json({
      success: true,
      publicUrl: fileUrl,
      url: fileUrl,
      key: fileRecord._id.toString(),
      format: mimetype.split('/')[1] || 'jpeg',
      bytes: buffer.length
    });
  } catch (error) {
    console.error('[DIRECT UPLOAD] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to upload file',
      details: error.message
    });
  }
};

router.post('/direct', uploadMiddleware.single('file'), handleDirectUpload);
router.put('/direct', uploadMiddleware.single('file'), handleDirectUpload);

router.post('/presigned-url', async (req, res) => {
  try {
    const s3Config = getS3Config();
    if (!s3Config) {
      return res.json({
        success: true,
        useDirectUpload: true,
        message: 'Direct upload mode enabled'
      });
    }

    const fileName = req.body.fileName || req.body.filename;
    const fileType = req.body.fileType || req.body.type || 'image/jpeg';
    const fileSize = req.body.fileSize || req.body.size || 1024 * 1024;
    const category = req.body.category || 'forms';
    const targetFormId = req.body.formId || req.body.associatedId;

    if (!fileName) {
      return res.status(400).json({
        success: false,
        error: 'fileName is required'
      });
    }

    const categoryConfig = CATEGORIES[category] || CATEGORIES.forms;
    if (fileSize > categoryConfig.maxSize) {
      return res.status(400).json({
        success: false,
        error: `File size exceeds limit of ${categoryConfig.maxSize / (1024 * 1024)}MB`
      });
    }

    const extension = ALLOWED_FILE_TYPES[fileType] || 'jpg';
    const safeBase = fileName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '_');
    const uniquePart = `${Date.now()}_${uuidv4().substring(0, 8)}`;
    const uniqueFileName = `${safeBase}_${uniquePart}.${extension}`;

    const folderPrefix = (targetFormId && (category === 'forms' || category === 'form' || category === 'evidence'))
      ? `focus_forms/forms/${targetFormId}/`
      : categoryConfig.path;

    const key = `${folderPrefix}${uniqueFileName}`;

    const command = new PutObjectCommand({
      Bucket: s3Config.s3Bucket,
      Key: key,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3Config.s3Client, command, { expiresIn: 3600 });
    const publicUrl = `https://${s3Config.cloudfrontDomain}/${key}`;

    res.json({
      success: true,
      uploadUrl,
      publicUrl,
      key
    });
  } catch (error) {
    console.error('Presigned URL error:', error);
    res.json({
      success: true,
      useDirectUpload: true,
      message: 'Falling back to direct upload'
    });
  }
});

export default router;
