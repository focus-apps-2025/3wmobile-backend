import { v2 as cloudinary } from 'cloudinary';


export const uploadToCloudinary = async (fileBuffer, filename, folder = 'focus_forms') => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto', // Changed from 'image' to 'auto'
        folder: folder,
        public_id: filename.replace(/\.[^/.]+$/, ''),
        overwrite: true,
        quality: 'auto:good', // Lower quality for large files
        fetch_format: 'auto',
        timeout: 180000, // 3 MINUTES timeout (increased from 60000)
        chunk_size: 6000000, // 6MB chunks for large files
        eager_async: true // Process asynchronously
      },
      (error, result) => {
        if (error) {
          console.error('[CLOUDINARY] Upload error:', error);
          reject(error);
        } else {
          console.log('[CLOUDINARY] Upload successful:', result.secure_url);
          resolve(result);
        }
      }
    );

    stream.on('error', (error) => {
      console.error('[CLOUDINARY] Stream error:', error);
      reject(error);
    });

    stream.end(fileBuffer);
  });
};

export const deleteFromCloudinary = async (publicId) => {
  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });

    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    throw error;
  }
};

export const generateCloudinarySignature = (params) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  return cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
};