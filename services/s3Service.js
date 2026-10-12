import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config'; 

// Configure AWS S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_S3_REGION || 'ap-south-1', // Mumbai region
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Configuration
const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'ib-project';
const CLOUDFRONT_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN || 'd196xvstj956a9.cloudfront.net';

/**
 * Upload file to S3 (replaces uploadToCloudinary)
 * @param {Buffer} fileBuffer - File buffer to upload
 * @param {string} filename - Original filename
 * @param {string} folder - Folder path in S3 (default: 'focus_forms')
 * @returns {Promise<Object>} Upload result with URL and metadata
 */
export const uploadToS3 = async (fileBuffer, filename, folder = 'focus_forms') => {
  try {
    // Generate unique filename (similar to Cloudinary's public_id)
    const fileExtension = filename.split('.').pop();
    const uniqueId = uuidv4();
    const safeFilename = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '_');
    const s3Filename = `${safeFilename}_${uniqueId}.${fileExtension}`;
    
    // S3 key (path in bucket)
    const s3Key = `${folder}/${s3Filename}`;
    
    // Determine content type
    const contentType = getContentType(fileExtension);
    
    console.log(`[S3] Uploading: ${s3Key} (${fileBuffer.length} bytes)`);

    // Upload to S3
    const uploadCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      Metadata: {
        originalFilename: filename,
        uploadedAt: new Date().toISOString()
      }
    });

    await s3Client.send(uploadCommand);
    
    // Construct CloudFront URL (NOT S3 URL)
    const cloudfrontUrl = `https://${CLOUDFRONT_DOMAIN}/${s3Key}`;
    
    console.log(`[S3] Upload successful: ${cloudfrontUrl}`);
    
    // Return result in similar format to Cloudinary
    return {
      secure_url: cloudfrontUrl,
      public_id: s3Key, // Using S3 key as public_id equivalent
      format: fileExtension,
      resource_type: 'image',
      bytes: fileBuffer.length,
      created_at: new Date().toISOString(),
      // Additional metadata for compatibility
      url: cloudfrontUrl,
      original_filename: filename,
      s3_key: s3Key,
      folder: folder
    };
    
  } catch (error) {
    console.error('[S3] Upload error:', error);
    throw error;
  }
};

/**
 * Delete file from S3 (replaces deleteFromCloudinary)
 * @param {string} s3Key - S3 key (path) of file to delete
 * @returns {Promise<Object>} Delete result
 */
export const deleteFromS3 = async (s3Key) => {
  try {
    console.log(`[S3] Deleting: ${s3Key}`);

    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key
    });

    await s3Client.send(deleteCommand);
    
    console.log(`[S3] Delete successful: ${s3Key}`);
    
    return {
      result: 'ok',
      message: 'File deleted successfully'
    };
    
  } catch (error) {
    console.error('[S3] Delete error:', error);
    throw error;
  }
};

/**
 * Helper function to determine content type from file extension
 */
const getContentType = (extension) => {
  const contentTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo'
  };
  
  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
};

/**
 * Optional: Generate signed URL for temporary access
 * Useful for private files that need time-limited access
 */
export const generateSignedUrl = async (s3Key, expiresIn = 3600) => {
  // Note: For CloudFront, you'd typically use CloudFront signed URLs/cookies
  // This is for direct S3 access if needed
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
};