import axios from 'axios';
import https from 'https';  
import { uploadToS3 } from './s3Service.js'; // Add this import at top
import { uploadToCloudinary } from './cloudinaryService.js';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import sharp from 'sharp';
import mongoose from 'mongoose';
import Form from '../models/Form.js';
import Tenant from '../models/Tenant.js';
import 'dotenv/config'; 

// ========== OAUTH 2.0 IMPORTS ==========
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Readable } from 'stream';

// Create optimized HTTP client with connection pooling
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    maxSockets: 80,
    maxFreeSockets: 100,
    timeout: 60000
  }),
  timeout: 120000
});

// Cache for already processed URLs (24-hour TTL)
const processedCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ========== OAUTH 2.0 CLIENT SETUP ==========
let oauth2Client = null;

const initOAuthClient = () => {
  if (!process.env.GOOGLE_DRIVE_CLIENT_ID || !process.env.GOOGLE_DRIVE_CLIENT_SECRET) {
    console.warn('[OAuth] Client ID or Secret not configured');
    return null;
  }

  oauth2Client = new OAuth2Client(
    process.env.GOOGLE_DRIVE_CLIENT_ID,
    process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:3000/api/drive/oauth/callback'
  );

  // Set stored refresh token
  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN
    });
    console.log('[OAuth] Client initialized with refresh token');
  }

  return oauth2Client;
};

const refreshAccessToken = async () => {
  try {
    if (!oauth2Client) {
      oauth2Client = initOAuthClient();
    }

    if (!oauth2Client.credentials.refresh_token) {
      throw new Error('No refresh token available');
    }

    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    
    console.log('[OAuth] Access token refreshed');
    return credentials.access_token;
  } catch (error) {
    console.error('[OAuth] Failed to refresh token:', error.message);
    throw error;
  }
};

const getDriveClient = async () => {
  if (!oauth2Client) {
    oauth2Client = initOAuthClient();
  }

  // Check if token needs refresh
  if (oauth2Client.credentials.expiry_date) {
    const now = Date.now();
    if (now >= oauth2Client.credentials.expiry_date - 60000) {
      console.log('[OAuth] Token expiring, refreshing...');
      await refreshAccessToken();
    }
  }

  return google.drive({ version: 'v3', auth: oauth2Client });
};

// Helper functions (keep these)
export const extractFileId = (url) => {
  if (!url || typeof url !== 'string') return null;
  
  const patterns = [
    /\/d\/([a-zA-Z0-9-_]+)/,
    /id=([a-zA-Z0-9-_]+)/,
    /file\/d\/([a-zA-Z0-9-_]+)/,
    /view\?id=([a-zA-Z0-9-_]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  
  return null;
};

export const isGoogleDriveUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.includes('drive.google.com') || extractFileId(url) !== null;
};

// ========== OAUTH DRIVE FUNCTIONS ==========

// Create Google Drive folder structure (OAuth 2.0)
const createGoogleDriveFolder = async (tenantName, formTitle) => {
  try {
    console.log('[Google Drive Debug] Starting folder creation...');
    
    // Check if OAuth is configured
    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
      console.warn('[OAuth] No refresh token available in GOOGLE_DRIVE_REFRESH_TOKEN - skipping folder creation');
      return null;
    }

    const drive = await getDriveClient();
    
    // Use your specific folder ID or root
    const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'root';

    // Helper function to create/check folder
    const ensureFolder = async (parentId, folderName) => {
      try {
        const response = await drive.files.list({
          q: `'${parentId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id, name)',
          spaces: 'drive'
        });

        if (response.data.files.length > 0) {
          console.log(`[Google Drive Debug] Folder "${folderName}" already exists`);
          return response.data.files[0].id;
        }

        // Create folder
        const folderMetadata = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        };

        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id'
        });

        console.log(`[Google Drive Debug] Created folder "${folderName}" with ID: ${folder.data.id}`);
        return folder.data.id;
      } catch (error) {
        console.error(`[Google Drive Debug] Error creating folder "${folderName}":`, error.message);
        throw error;
      }
    };

    // Create folder structure inside your specific folder
    // First, check if FocusForms_Images exists in your folder
    const focusFormsId = await ensureFolder(rootFolderId, 'FocusForms_Images');
    const tenantFolderId = await ensureFolder(focusFormsId, tenantName);
    const formFolderId = await ensureFolder(tenantFolderId, formTitle);

    console.log(`[Google Drive Debug] Folder structure: FocusForms_Images/${tenantName}/${formTitle}/`);
    console.log(`[Google Drive Debug] Using OAuth 2.0 with user account`);
    
    return {
      formFolderId,
      fullPath: `FocusForms_Images/${tenantName}/${formTitle}/`,
      tenantName,
      formTitle,
      rootFolderId: rootFolderId
    };

  } catch (error) {
    console.error('[Google Drive Debug] Failed to create folders:', error.message);
    
    if (error.message.includes('invalid_grant')) {
      console.error('[OAuth] Token invalid or revoked. Need new authorization.');
    }
    
    return null;
  }
};

// Upload single image to Google Drive (OAuth 2.0)
const uploadToGoogleDrive = async (buffer, fileName, folderId) => {
  try {
    if (!folderId) {
      console.warn('[OAuth] No folder ID provided for upload');
      return null;
    }

    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
      console.warn('[OAuth] No refresh token available - skipping upload');
      return null;
    }

    const drive = await getDriveClient();
    
    console.log(`[OAuth] Uploading: ${fileName} (${buffer.length} bytes)`);
    console.log(`[OAuth] Folder ID: ${folderId}`);

    const fileMetadata = {
      name: fileName,
      parents: [folderId]
    };

    const media = {
      mimeType: 'image/jpeg',
      body: Readable.from(buffer)
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name, size'
    });

    console.log(`✅ [OAuth] Google Drive upload successful: ${fileName}`);
    console.log(`   File ID: ${file.data.id}`);
    console.log(`   File URL: ${file.data.webViewLink}`);

    // Make file publicly viewable
    try {
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });
      console.log('   [OAuth] Made file publicly readable');
    } catch (permError) {
      console.warn('   [OAuth] Could not set public permissions:', permError.message);
    }

    return {
      driveFileId: file.data.id,
      driveUrl: file.data.webViewLink,
      directUrl: `https://drive.google.com/uc?export=view&id=${file.data.id}`,
      fileName: file.data.name,
      size: file.data.size
    };

  } catch (error) {
    console.error('❌ [OAuth] Google Drive upload failed:', error.message);
    
    if (error.message.includes('invalid_grant')) {
      console.error('[OAuth] Token expired or revoked. Need to re-authenticate.');
    } else if (error.message.includes('insufficientStorage')) {
      console.error('[OAuth] User Drive storage is full!');
    }
    
    return null;
  }
};

// ========== EXISTING CODE (UNCHANGED) ==========
// Bulk download - handles ANY image URL, not just Google Drive
const bulkDownload = async (urls, batchSize = 15) => {
  const results = [];
  
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchPromises = batch.map(async (url) => {
      const downloadWithRetry = async (url, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const cacheKey = `download_${url}`;
            if (processedCache.has(cacheKey)) {
              const cached = processedCache.get(cacheKey);
              if (Date.now() - cached.timestamp < CACHE_TTL) {
                return cached.data;
              }
            }
            
            const timeout = 30000 * attempt;
            console.log(`Attempt ${attempt} for ${url.substring(0, 50)}... (timeout: ${timeout}ms)`);
            
            let downloadUrl = url;
            let headers = {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'image/*'
            };
            
            // Check if it's a Google Drive URL
            const fileId = extractFileId(url);
            if (fileId) {
              // Google Drive URL - use the special download endpoint
              downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
              headers['Referer'] = 'https://drive.google.com/';
            }
            // For other URLs (Cloudinary, direct links, etc.), use the URL as-is
            
            const response = await axiosInstance.get(
              downloadUrl,
              {
                responseType: 'arraybuffer',
                timeout: timeout,
                headers: headers
              }
            );
            
            if (response.status !== 200) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const contentType = response.headers['content-type'] || 'image/jpeg';
            if (!contentType.startsWith('image/')) {
              console.warn(`Expected image, got ${contentType} for ${url}`);
            }
            
            const result = {
              url,
              buffer: Buffer.from(response.data),
              contentType,
              size: response.data.length,
              success: true
            };
            
            processedCache.set(cacheKey, {
              data: result,
              timestamp: Date.now()
            });
            
            console.log(`✓ Downloaded ${url.substring(0, 50)}... (${response.data.length} bytes)`);
            return result;
            
          } catch (error) {
            console.warn(`Attempt ${attempt} failed for ${url}: ${error.message}`);
            
            if (attempt === retries) {
              return {
                url,
                error: error.message,
                success: false
              };
            }
            
            const delay = 1000 * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      };
      
      return await downloadWithRetry(url);
    });
    
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
    
    const successful = batchResults.filter(r => 
      r.status === 'fulfilled' && r.value.success
    ).length;
    
    console.log(`Batch ${Math.floor(i/batchSize) + 1}: ${successful}/${batch.length} successful`);
    
    const successRate = successful / batch.length;
    const delay = successRate < 0.5 ? 500 : 200;
    
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return results;
};

// Compress image if too large
const compressImageIfNeeded = async (buffer, maxSizeMB = 5) => {
  try {
    const sizeInMB = buffer.length / (1024 * 1024);
    
    if (sizeInMB <= maxSizeMB) {
      console.log(`Image size: ${sizeInMB.toFixed(2)}MB (no compression needed)`);
      return buffer;
    }
    
    console.log(`Compressing large image: ${sizeInMB.toFixed(2)}MB -> target ${maxSizeMB}MB`);
    
    const compressedBuffer = await sharp(buffer)
      .resize(1920, 1080, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ 
        quality: 80,
        mozjpeg: true 
      })
      .toBuffer();
    
    const compressedSizeMB = compressedBuffer.length / (1024 * 1024);
    console.log(`Compressed to: ${compressedSizeMB.toFixed(2)}MB (${Math.round((compressedSizeMB / sizeInMB) * 100)}% of original)`);
    
    return compressedBuffer;
    
  } catch (error) {
    console.error('Image compression failed:', error);
    return buffer;
  }
};

// ========== MAIN UPLOAD FUNCTION (Dual Storage) ==========
// Upload to BOTH Cloudinary and Google Drive
const bulkUpload = async (images, folder = 'focus_forms/response_images', driveFolderInfo = null) => {
  const uploadPromises = images.map(async (image, index) => {
    if (!image || !image.success) {
      return {
        originalUrl: image?.url,
        error: image?.error || 'Download failed',
        success: false
      };
    }
    
    try {
      const cacheKey = `upload_${image.url}`;
      if (processedCache.has(cacheKey)) {
        const cached = processedCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
          console.log(`Cache hit for ${image.url.substring(0, 50)}...`);
          return cached.data;
        }
      }
      
      console.log(`Original size: ${(image.size / (1024 * 1024)).toFixed(2)}MB`);
      let finalBuffer = image.buffer;
      
      if (image.size > 5 * 1024 * 1024) {
        finalBuffer = await compressImageIfNeeded(image.buffer, 5);
      }
      
      const filename = `response-${Date.now()}-${index}.jpg`;
      console.log(`Processing: ${filename}`);
      
      // 1. UPLOAD TO CLOUDINARY (PRIMARY)
     /* const cloudinaryResult = await uploadToCloudinary(
        finalBuffer,
        filename,
        folder
      );*/
      const s3Result = await uploadToS3(
  finalBuffer,
  filename,
  'focus_forms/response_images' // Your folder structure
);
      
      // 2. UPLOAD TO GOOGLE DRIVE (BACKUP) - USING OAUTH 2.0
      let driveResult = null;
      if (driveFolderInfo?.formFolderId) {
        driveResult = await uploadToGoogleDrive(
          finalBuffer,
          filename,
          driveFolderInfo.formFolderId
        );
      }
      
     /* const uploadResult = {
        originalUrl: image.url,
        cloudinaryUrl: cloudinaryResult.secure_url,
        cloudinaryPublicId: cloudinaryResult.public_id,
        driveUrl: driveResult?.driveUrl || null,
        driveFileId: driveResult?.driveFileId || null,
        drivePath: driveFolderInfo?.fullPath ? `${driveFolderInfo.fullPath}${filename}` : null,
        success: true
      };
      */
     const uploadResult = {
  originalUrl: image.url,
  cloudinaryUrl: s3Result.secure_url, // Now S3/CloudFront URL
  cloudinaryPublicId: s3Result.public_id, // Now S3 key
  driveUrl: driveResult?.driveUrl || null,
  driveFileId: driveResult?.driveFileId || null,
  drivePath: driveFolderInfo?.fullPath ? `${driveFolderInfo.fullPath}${filename}` : null,
  success: true
};
      
      processedCache.set(cacheKey, {
        data: uploadResult,
        timestamp: Date.now()
      });
      
      console.log(`✓ Processed: ${filename}`);
      console.log(`  S3: ${s3Result.secure_url}`);
      console.log(`  Google Drive: ${driveResult?.driveUrl || 'Backup skipped'}`);
      
      return uploadResult;
      
    } catch (error) {
      console.error(`❌ Processing failed for ${image.url}:`, error.message);
      return {
        originalUrl: image.url,
        error: error.message,
        success: false
      };
    }
  });
  
  const batchSize = 5;
  const results = [];
  
  for (let i = 0; i < uploadPromises.length; i += batchSize) {
    const batch = uploadPromises.slice(i, i + batchSize);
    console.log(`Upload batch ${Math.floor(i/batchSize) + 1}: ${i+1}-${Math.min(i+batchSize, uploadPromises.length)}`);
    
    const batchResults = await Promise.allSettled(batch);
    results.push(...batchResults);
    
    if (i + batchSize < uploadPromises.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
};

// ========== MAIN PROCESSING FUNCTION ==========
export const processResponseImages = async (answers, metadata = {}, onProgress = null, batchId = null) => {
  try {
    console.log(`[BATCH ${batchId || 'PROCESS'}] Starting image processing`);
    
    if (!answers || (typeof answers !== 'object' && !(answers instanceof Map))) {
      return answers;
    }
    
    const entries = answers instanceof Map ? 
      Array.from(answers.entries()) : 
      Object.entries(answers);
    
    const imageTasks = [];
    const isImageUrl = (url) => {
      if (!url || typeof url !== 'string') return false;
      // Check for common image URL patterns
      const imagePatterns = [
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i,
        /drive\.google\.com/i,
        /res\.cloudinary\.com/i,
        /cloudinary\.com/i,
        /\/image\//i
      ];
      return imagePatterns.some(pattern => pattern.test(url));
    };

    entries.forEach(([questionId, answer]) => {
      if (!answer) return;
      
      if (typeof answer === 'string' && isImageUrl(answer)) {
        imageTasks.push({
          questionId,
          url: answer,
          type: 'single',
          source: isGoogleDriveUrl(answer) ? 'google-drive' : 'other'
        });
      } else if (Array.isArray(answer)) {
        answer.forEach((item, index) => {
          if (typeof item === 'string' && isImageUrl(item)) {
            imageTasks.push({
              questionId,
              url: item,
              type: 'array',
              arrayIndex: index,
              source: isGoogleDriveUrl(item) ? 'google-drive' : 'other'
            });
          }
        });
      }
    });
    
    const totalImages = imageTasks.length;
    console.log(`[BATCH ${batchId || 'PROCESS'}] Found ${totalImages} images to process`);
    
    if (totalImages === 0) {
      return {
        processedAnswers: answers,
        driveBackupUrls: {},
        stats: {
          totalImages: 0,
          successfulUploads: 0,
          successfulDriveBackups: 0
        }
      };
    }
    
    // Get Google Drive folder info if we have tenant and form
    let driveFolderInfo = null;
    console.log(`[Google Drive Debug] Metadata: tenantId=${metadata.tenantId}, formId=${metadata.formId}`);
    if (metadata.tenantId && metadata.formId) {
      try {
        const tenant = await Tenant.findById(metadata.tenantId);
        const form = await Form.findOne({ id: metadata.formId });
        
        console.log(`[Google Drive Debug] Found tenant: ${!!tenant}, Found form: ${!!form}`);
        if (tenant && form) {
          const tenantName = tenant.name || tenant.slug || `Tenant-${metadata.tenantId}`;
          const formTitle = form.title || `Form-${metadata.formId}`;
          
          driveFolderInfo = await createGoogleDriveFolder(tenantName, formTitle);
          if (driveFolderInfo) {
            console.log(`[Google Drive Debug] Folder ready: ${driveFolderInfo.fullPath}`);
          } else {
            console.warn('[Google Drive Debug] Folder creation returned null');
          }
        } else {
          console.warn(`[Google Drive Debug] Skipping folder creation: tenant=${!!tenant}, form=${!!form}`);
        }
      } catch (error) {
        console.error('[Google Drive Debug] Could not create Google Drive folders:', error.message);
      }
    } else {
      console.warn('[Google Drive Debug] Missing metadata for folder creation');
    }
    
    // Progress tracking
    let processedCount = 0;
    const updateProgress = (increment = 1, message = null) => {
      processedCount += increment;
      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          currentImage: processedCount,
          totalImages,
          status: 'processing',
          message: message || `Processing ${processedCount}/${totalImages} images...`,
          percentage: Math.round((processedCount / totalImages) * 100)
        });
      }
    };

    if (onProgress && typeof onProgress === 'function') {
      onProgress({
        currentImage: 0,
        totalImages,
        status: 'starting',
        message: `Starting processing of ${totalImages} images...`,
        percentage: 0
      });
    }
    
    // Download images
    const downloads = await bulkDownload(imageTasks.map(t => t.url));
    const validDownloads = downloads
      .filter(r => r.status === 'fulfilled' && r.value.success)
      .map(r => r.value);
    
    console.log(`[BATCH ${batchId || 'PROCESS'}] ${validDownloads.length}/${totalImages} downloads successful`);
    
    // Upload to both Cloudinary and Google Drive
    const uploads = await bulkUpload(validDownloads, 'focus_forms/response_images', driveFolderInfo);
    
    const successfulUploads = uploads
      .filter(r => r.status === 'fulfilled' && r.value.success)
      .map(r => r.value);
    
    console.log(`[BATCH ${batchId || 'PROCESS'}] ${successfulUploads.length}/${validDownloads.length} uploads successful`);
    
    // Map results
    const processedResults = new Map();
    const driveBackupUrls = new Map();
    
    successfulUploads.forEach((upload, index) => {
      const task = imageTasks[index];
      if (!task) return;
      
      if (!processedResults.has(task.questionId)) {
        processedResults.set(task.questionId, {});
      }
      
      const questionData = processedResults.get(task.questionId);
      questionData[upload.originalUrl] = upload.cloudinaryUrl;
      
      if (upload.driveUrl) {
        if (!driveBackupUrls.has(task.questionId)) {
          driveBackupUrls.set(task.questionId, []);
        }
        
        driveBackupUrls.get(task.questionId).push({
          cloudinaryUrl: upload.cloudinaryUrl,
          driveUrl: upload.driveUrl,
          driveFileId: upload.driveFileId,
          drivePath: upload.drivePath,
          originalUrl: upload.originalUrl,
          uploadedAt: new Date().toISOString()
        });
      }
    });
    
    // Update answers
    const processedAnswers = answers instanceof Map ? new Map(answers) : { ...answers };
    
    entries.forEach(([questionId, answer]) => {
      if (!answer) return;
      
      const replacements = processedResults.get(questionId);
      if (!replacements) return;
      
      if (typeof answer === 'string' && replacements[answer]) {
        if (answers instanceof Map) {
          processedAnswers.set(questionId, replacements[answer]);
        } else {
          processedAnswers[questionId] = replacements[answer];
        }
      } else if (Array.isArray(answer)) {
        const updatedArray = answer.map(item => 
          (typeof item === 'string' && replacements[item]) ? replacements[item] : item
        );
        
        if (answers instanceof Map) {
          processedAnswers.set(questionId, updatedArray);
        } else {
          processedAnswers[questionId] = updatedArray;
        }
      }
    });
    
    // Final progress
    if (onProgress && typeof onProgress === 'function') {
      onProgress({
        currentImage: totalImages,
        totalImages,
        status: 'complete',
        message: `✓ Processed ${successfulUploads.length}/${totalImages} images successfully`,
        percentage: 100
      });
    }
    
    console.log(`[BATCH ${batchId || 'PROCESS'}] Image processing complete`);
    
    return {
      processedAnswers,
      driveBackupUrls: Object.fromEntries(driveBackupUrls.entries()),
      folderStructure: driveFolderInfo,
      stats: {
        totalImages,
        successfulUploads: successfulUploads.length,
        successfulDriveBackups: successfulUploads.filter(u => u.driveUrl).length
      }
    };
    
  } catch (error) {
    console.error('[IMAGE PROCESS] Major error:', error);
    
    if (onProgress && typeof onProgress === 'function') {
      onProgress({
        status: 'error',
        message: `Processing failed: ${error.message}`,
        error: error.message
      });
    }
    
    return {
      processedAnswers: answers,
      driveBackupUrls: {},
      error: error.message
    };
  }
};

// ========== NEW OAUTH SETUP FUNCTIONS ==========

/**
 * Get OAuth consent URL for initial setup
 */
export const getOAuthConsentUrl = () => {
  const client = initOAuthClient();
  if (!client) {
    throw new Error('OAuth client not initialized');
  }

  const scopes = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.metadata'
  ];

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
};

/**
 * Exchange authorization code for tokens
 */
export const exchangeCodeForTokens = async (code) => {
  try {
    const client = initOAuthClient();
    if (!client) {
      throw new Error('OAuth client not initialized');
    }

    const { tokens } = await client.getToken(code);
    
    // Save refresh token
    console.log('✅ Tokens received successfully!');
    console.log('Refresh Token:', tokens.refresh_token);
    
    client.setCredentials(tokens);
    
    return {
      success: true,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token
    };
  } catch (error) {
    console.error('Token exchange failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Test Drive connection
 */
export const testDriveConnection = async () => {
  try {
    console.log('[OAuth] Testing Google Drive connection...');
    
    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
      return {
        success: false,
        message: 'No refresh token configured'
      };
    }

    const drive = await getDriveClient();
    
    const about = await drive.about.get({
      fields: 'user, storageQuota'
    });
    
    console.log('✅ Drive connection successful!');
    console.log('   User:', about.data.user.emailAddress);
    
    return {
      success: true,
      user: about.data.user,
      storage: about.data.storageQuota
    };
  } catch (error) {
    console.error('❌ Drive connection test failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

// ========== EXISTING EXPORTS ==========
export const processGoogleDriveImage = async (imageUrl, questionId) => {
  try {
    if (!isGoogleDriveUrl(imageUrl)) {
      return imageUrl;
    }
    
    const results = await processResponseImages(
      { [questionId]: imageUrl },
      null,
      `single-${questionId}`
    );
    
    return results.processedAnswers[questionId] || imageUrl;
  } catch (error) {
    console.error(`Single image processing failed for ${questionId}:`, error);
    return imageUrl;
  }
};

export const clearProcessedCache = () => {
  processedCache.clear();
  console.log('[IMAGE PROCESS] Cache cleared');
};

export const getCacheStats = () => {
  return {
    size: processedCache.size,
    entries: Array.from(processedCache.entries()).map(([key, value]) => ({
      key: key.substring(0, 50) + '...',
      timestamp: value.timestamp,
      age: Date.now() - value.timestamp
    }))
  };
};

// Initialize OAuth client on import
initOAuthClient();