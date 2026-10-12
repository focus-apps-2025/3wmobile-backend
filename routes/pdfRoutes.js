import express from 'express';
import pdfService from '../services/pdfService.js';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const router = express.Router();

// Generate PDF with format option
router.post('/generate', async (req, res) => {
  const startTime = Date.now();

  try {
    let {
      htmlContent,
      filename = 'report.pdf',
      format = 'custom', // 'custom' or 'a4'
      compressed = false
    } = req.body;

    if (!htmlContent) {
      return res.status(400).json({
        error: 'HTML content is required'
      });
    }

    console.log('📥 Received PDF request');
    console.log(`📦 Compressed: ${compressed}, Initial size: ${htmlContent.length} bytes`);

    // Decompress if needed
    if (compressed) {
      try {
        console.log('📦 Decompressing content...');
        const buffer = Buffer.from(htmlContent, 'base64');
        console.log(`📦 Buffer size: ${buffer.length} bytes`);
        const decompressed = await gunzip(buffer);
        htmlContent = decompressed.toString('utf-8');
        console.log(`✅ Decompressed: ${(htmlContent.length / 1024).toFixed(2)} KB`);
      } catch (decompressError) {
        console.error('❌ Decompression failed:', decompressError.message);
        return res.status(400).json({
          error: 'Failed to decompress content',
          details: decompressError.message
        });
      }
    }

    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`📊 Starting PDF generation... (Memory usage: ${Math.round(used * 100) / 100} MB)`);
    console.log(`📄 Content length: ${htmlContent.length} characters`);
    console.log(`📐 Format: ${format}`);

    // For very large content, add warnings
    if (htmlContent.length > 1000000) {
      console.log(`⚠️ Large document detected: ${(htmlContent.length / 1024 / 1024).toFixed(2)} MB`);
    }

    // Choose generation method based on format
    let pdfBuffer;
    try {
      if (format === 'custom') {
        console.log('📐 Using custom format: 279.4mm × 157.1mm');
        pdfBuffer = await pdfService.generatePDFWithCustomFormat(htmlContent);
      } else if (format === 'a4') {
        console.log('📐 Using A4 landscape format');
        pdfBuffer = await pdfService.generatePDFWithA4(htmlContent);
      } else if (format === 'a4-portrait') {
        console.log('📐 Using A4 portrait format');
        pdfBuffer = await pdfService.generatePDFWithA4Portrait(htmlContent);
      } else {
        // Default to custom format
        pdfBuffer = await pdfService.generatePDFWithCustomFormat(htmlContent);
      }
    } catch (serviceError) {
      console.error('❌ PDF Service Error:', serviceError);
      throw serviceError; // Re-throw to be caught by outer catch
    }

    const duration = (Date.now() - startTime) / 1000;
    const usedAfter = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`✅ PDF generated in ${duration.toFixed(2)}s (Memory usage: ${Math.round(usedAfter * 100) / 100} MB)`);

    // Sanitize filename for Content-Disposition header
    // 1. Basic ASCII-only filename for older clients
    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    // 2. UTF-8 encoded filename for modern clients (RFC 6266)
    const encodedFilename = encodeURIComponent(filename);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('X-Generation-Time', `${duration}s`);
    res.setHeader('X-PDF-Format', format);

    res.send(pdfBuffer);

  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    console.error(`❌ PDF generation failed after ${duration}s:`, error.message);
    console.error('Stack trace:', error.stack);

    // Provide more helpful error messages
    let errorMessage = error.message;
    let suggestion = '';

    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      suggestion = 'Chrome/Chromium binary not found. Make sure Puppeteer is properly installed.';
    } else if (error.message.includes('Timeout')) {
      suggestion = 'The document is too large. Try reducing the content or contact support.';
    } else if (error.message.includes('ensureInitialized') || error.message.includes('disconnected')) {
      suggestion = 'PDF service initialization failed. Browser may have crashed.';
    } else if (error.message.includes('ENOMEM') || error.message.includes('memory')) {
      suggestion = 'Out of memory. Please try with smaller content.';
    }

    res.status(500).json({
      error: 'Failed to generate PDF',
      details: errorMessage,
      suggestion: suggestion,
      duration: `${duration}s`,
      stack: error.stack
    });
  }
});

// Test endpoint with custom format
router.post('/test-custom-format', async (req, res) => {
  try {
    const testHTML = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { 
              font-family: Arial; 
              padding: 20px; 
              width: 259.4mm; /* Page width minus margins */
              margin: 0 auto;
            }
            h1 { color: #1e3a8a; }
            .info { 
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 20px;
              margin: 20px 0;
            }
            .box {
              border: 1px solid #ddd;
              padding: 15px;
              border-radius: 5px;
            }
          </style>
        </head>
        <body>
          <h1>Custom Format Test (279.4mm × 157.1mm)</h1>
          <p>Testing PDF generation with custom landscape format</p>
          
          <div class="info">
            <div class="box">
              <h3>Format Details</h3>
              <p>Width: 279.4mm</p>
              <p>Height: 157.1mm</p>
              <p>Aspect Ratio: ~1.78</p>
            </div>
            
            <div class="box">
              <h3>Test Content</h3>
              <p>Time: ${new Date().toLocaleString()}</p>
              <p>This is a test of the custom PDF format.</p>
            </div>
          </div>
          
          <table border="1" style="width: 100%; margin-top: 20px;">
            <tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr>
            <tr><td>Data 1</td><td>Data 2</td><td>Data 3</td></tr>
            <tr><td>Data 4</td><td>Data 5</td><td>Data 6</td></tr>
          </table>
        </body>
      </html>
    `;

    const pdfBuffer = await pdfService.generatePDFWithCustomFormat(testHTML);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="custom-format-test.pdf"'
    });

    res.send(pdfBuffer);

  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({
      error: 'Test failed',
      details: error.message
    });
  }
});
// Add this new route after your existing routes
router.post('/generate-overall', async (req, res) => {
  const startTime = Date.now();

  try {
    let {
      htmlContent,
      filename = 'overall-report.pdf'
    } = req.body;

    if (!htmlContent) {
      return res.status(400).json({
        error: 'HTML content is required'
      });
    }

    console.log('📥 Received Overall PDF request');
    console.log(`📄 Content length: ${htmlContent.length} characters`);

    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`📊 Starting PDF generation... (Memory usage: ${Math.round(used * 100) / 100} MB)`);

    // Generate PDF with A4 Portrait format
    const pdfBuffer = await pdfService.generatePDFWithA4Portrait(htmlContent);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ Overall PDF generated in ${duration.toFixed(2)}s`);

    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    const encodedFilename = encodeURIComponent(filename);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('X-Generation-Time', `${duration}s`);

    res.send(pdfBuffer);

  } catch (error) {
    console.error(`❌ Overall PDF generation failed:`, error.message);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});
export default router;