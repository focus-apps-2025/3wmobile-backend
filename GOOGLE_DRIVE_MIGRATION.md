# Google Drive Image Migration Guide

This guide explains how to download and store Google Drive images from responses in your Cloudinary account instead of linking to Google Drive.

## Overview

The system now supports:
1. **Automatic processing** of Google Drive images in new responses
2. **Batch migration** of existing Google Drive images from past responses
3. **Fallback handling** if image download fails

## How It Works

### For New Responses
When a user submits a form with a Google Drive image link:
1. The link is automatically detected
2. The image is downloaded from Google Drive
3. The image is uploaded to Cloudinary
4. The response stores the Cloudinary URL instead of the Google Drive link

### For Existing Responses
Run the migration script to process all historical responses with Google Drive images.

## Running the Migration

### Prerequisites
- Cloudinary credentials configured in `.env`
- Node.js installed
- MongoDB connection available

### Steps

1. **Backup your database** (recommended)
   ```bash
   mongodump --uri="your_mongodb_uri" --out=./backup
   ```

2. **Run the migration script**
   ```bash
   node scripts/migrateGoogleDriveImages.js
   ```

3. **Monitor the output**
   The script will show:
   - Total responses processed
   - Number with Google Drive images
   - Successfully migrated count
   - Any failures with error details

### Example Output
```
Connecting to MongoDB...
Connected to MongoDB

Found 150 total responses

[1] Processing response abc123def...
✓ Successfully processed response abc123def

[2] Processing response xyz789...
✓ Successfully processed response xyz789

...

========== Migration Summary ==========
Total responses: 150
Responses with Google Drive images: 45
Successfully processed: 44
Failed: 1
=====================================
```

## Troubleshooting

### Script Stops with "Failed to download image"
- **Cause**: Google Drive link might have restricted access or be deleted
- **Solution**: The script continues with the original URL. Check the response manually.

### Cloudinary Upload Fails
- **Cause**: Invalid Cloudinary credentials or rate limiting
- **Solution**: 
  - Verify `.env` has correct `CLOUDINARY_*` values
  - Wait a few minutes and retry (Cloudinary may have rate limits)

### Script Takes Too Long
- The script intentionally pauses 1 second between each image to avoid rate limiting
- For 1000 images, expect ~15 minutes
- You can monitor progress in real-time

## Verification

After migration, verify the changes:

```bash
# Check a specific response
node -e "
const mongoose = require('mongoose');
const Response = require('./models/Response');
mongoose.connect('your_mongodb_uri').then(() => {
  Response.findOne({}).then(r => {
    console.log('Sample response answers:', r.answers);
  });
});
"
```

You should see Cloudinary URLs instead of Google Drive links for images.

## Rollback

If needed, you can restore from your MongoDB backup:
```bash
mongorestore --uri="your_mongodb_uri" ./backup
```

## Configuration

Edit `googleDriveService.js` if you need to customize:

- **Download timeout**: Line 28 - `timeout: 30000` (milliseconds)
- **Cloudinary folder**: Line 58 - Change `'focus_forms/response_images'`
- **Retry logic**: Add custom retry logic if needed

## Files Modified

- `services/googleDriveService.js` - Image download and processing service
- `scripts/migrateGoogleDriveImages.js` - Batch migration script
- `controllers/responseController.js` - Automatic processing for new responses

## API Changes

No API changes are required. The system automatically processes images in the background:

- **New responses**: Images are processed before saving
- **Updated responses**: If you update answers with Google Drive images, they're processed automatically

## Performance Impact

- **New response submission**: ~2-5 seconds additional processing time per image
- **Storage**: Images now stored in Cloudinary instead of Google Drive links
- **Database size**: Minimal increase (Cloudinary URLs are similar length to Google Drive URLs)

## Support

For issues, check:
1. Cloudinary credentials in `.env`
2. Network connectivity to Google Drive and Cloudinary
3. MongoDB connection logs
4. Script output for specific error messages
