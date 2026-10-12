import puppeteer from 'puppeteer';
import fs from 'fs';
import os from 'os';


class PDFService {
  constructor() {
    this.browser = null;
    this.initialized = false;
    this.initializationPromise = null;
  }

  // Check if there's enough free memory to run Puppeteer safely
  checkMemory(requiredMB = 150) {
    const freeMem = os.freemem();
    const freeMemMB = Math.round(freeMem / 1024 / 1024);
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    console.log(`💾 Memory check: ${freeMemMB}MB free / ${totalMemMB}MB total (need ${requiredMB}MB)`);
    return { ok: freeMemMB >= requiredMB, freeMemMB, totalMemMB };
  }

  async initBrowser() {
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = (async () => {
      try {
        // Memory guard — prevent OOM on small instances
        const memCheck = this.checkMemory(150);
        if (!memCheck.ok) {
          throw new Error(`Insufficient memory for PDF generation: ${memCheck.freeMemMB}MB free, need at least 150MB. Server has ${memCheck.totalMemMB}MB total.`);
        }

        console.log('🚀 Launching Puppeteer...');

        const launchOptions = {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--disable-web-resources',
            '--font-render-hinting=none',
            '--js-flags=--max-old-space-size=128'
          ],
          defaultViewport: { width: 1280, height: 1600 },
          timeout: 60000
        };

        // Try with explicit path first if provided
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
          launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
          // Look for common Chrome/Edge installation paths on Windows as fallbacks
          const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
          ];

          for (const path of possiblePaths) {
            if (fs.existsSync(path)) {
              console.log(`💡 Found fallback browser at: ${path}`);
              launchOptions.executablePath = path;
              break;
            }
          }
        }

        console.log('📋 Launching with options:', JSON.stringify(launchOptions));
        this.browser = await puppeteer.launch(launchOptions).catch(err => {
          console.error('❌ puppeteer.launch direct error:', err);
          throw err;
        });

        this.initialized = true;
        console.log('✅ Puppeteer ready');

        // Handle browser disconnect
        this.browser.on('disconnected', () => {
          console.log('⚠️ Browser disconnected');
          this.initialized = false;
          this.browser = null;
          this.initializationPromise = null;
        });

      } catch (error) {
        console.error('❌ Failed to launch Puppeteer:', error.message);
        console.error('Stack:', error.stack);
        this.initializationPromise = null;
        this.initialized = false;
        throw error;
      }
    })();

    return this.initializationPromise;
  }

  async ensureInitialized() {
    if (!this.initialized || !this.browser || !this.browser.isConnected()) {
      this.initializationPromise = null; // Reset promise if browser is not connected
      await this.initBrowser();
    } else if (this.initializationPromise) {
      await this.initializationPromise;
    }
    return this.initialized;
  }

  async getBrowser() {
    await this.ensureInitialized();
    return this.browser;
  }

  async generatePDF(htmlContent, options = {}) {
    console.log('🚀 Starting PDF generation...');
    console.log(`📊 HTML size: ${(htmlContent.length / 1024).toFixed(2)} KB`);

    let browser = null;
    let page = null;

    try {
      // Get or create browser
      console.log('📋 Getting browser instance...');
      browser = await this.getBrowser();
      console.log('✅ Browser acquired');

      // Create a fresh page for each request
      console.log('📄 Creating new page...');
      page = await browser.newPage();
      console.log('✅ Page created');

      // Prepare HTML (removes problematic elements)
      console.log('🧹 Preparing HTML...');
      const processedHTML = this.prepareHTMLForPDF(htmlContent);
      console.log(`✅ HTML prepared: ${processedHTML.length} chars`);

      console.log('📝 Setting HTML content...');

      // Set content with timeout
      await page.setContent(processedHTML, {
        waitUntil: 'domcontentloaded',
        timeout: 100000 // Increased timeout for large content
      });

      console.log('✅ HTML content loaded');

      // Wait for rendering
      console.log('⏳ Waiting for page render...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('✅ Page rendered');

      // Set page format based on options
      const format = options.format || 'custom'; // custom, a4, or a4-portrait
      const margin = options.margin || { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' };

      console.log(`📐 Generating PDF with format: ${format}`);

      let pdfOptions = {
        printBackground: true,
        margin: margin,
        displayHeaderFooter: false,
        preferCSSPageSize: false,
        timeout: 100000 // Increased timeout for large PDFs
      };

      // Apply format
      if (format === 'custom') {
        // Custom format: 279.4mm x 157.1mm (landscape)
        pdfOptions.width = '279.4mm';
        pdfOptions.height = '157.1mm';
        pdfOptions.landscape = false; // Already set by dimensions
      } else if (format === 'a4-portrait') {
        pdfOptions.format = 'A4';
        pdfOptions.landscape = false;
      } else {
        // Default to A4 landscape
        pdfOptions.format = 'A4';
        pdfOptions.landscape = true;
      }

      console.log('📄 Generating PDF buffer...');
      console.log('PDF Options:', JSON.stringify(pdfOptions, null, 2));

      const pdfBuffer = await page.pdf(pdfOptions).catch(err => {
        console.error('❌ page.pdf error:', err.message);
        throw new Error(`Puppeteer PDF generation failed: ${err.message}`);
      });

      console.log(`✅ PDF generated: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
      return pdfBuffer;

    } catch (error) {
      console.error('❌ PDF generation error:', error.message);
      console.error('❌ Full error:', error);
      console.error('❌ Stack:', error.stack);

      // Try with fresh browser instance
      if (browser) {
        try {
          await browser.close();
        } catch (e) { }
        this.browser = null;
        this.initialized = false;
      }

      throw error;

    } finally {
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error('Error closing page:', e.message);
        }
      }
    }
  }


  // Method for A4 format (for backward compatibility)
  async generatePDFWithA4(htmlContent) {
    console.log('🔄 Generating PDF with A4 landscape format...');
    return this.generatePDF(htmlContent, { format: 'a4' });
  }

  // Method for A4 portrait
  async generatePDFWithA4Portrait(htmlContent) {
    console.log('🔄 Generating PDF with A4 portrait format...');
    return this.generatePDF(htmlContent, { format: 'a4-portrait' });
  }

  // Method for custom format
  async generatePDFWithCustomFormat(htmlContent) {
    console.log('📐 Generating PDF with custom format...');
    return this.generatePDF(htmlContent, { format: 'custom' });
  }
  // Add this method to your PDFService class in pdfService.js

  /**
   * Generate Overall Report PDF with A4 Portrait format and optimized settings
   * Specifically designed for the Overall Analytics Dashboard
   */
  async generateOverallReportPDF(htmlContent) {
    console.log('📊 Generating Overall Report PDF (A4 Portrait)...');
    console.log(`📄 HTML size: ${(htmlContent.length / 1024).toFixed(2)} KB`);

    let browser = null;
    let page = null;

    try {
      // Get browser instance
      browser = await this.getBrowser();
      console.log('✅ Browser acquired');

      // Create new page
      page = await browser.newPage();
      console.log('✅ Page created');

      // Set viewport to A4 dimensions for consistent rendering
      await page.setViewport({
        width: 800,
        height: 1100,
        deviceScaleFactor: 1
      });

      // Prepare HTML with Overall Report specific styling
      const processedHTML = this.prepareOverallReportHTML(htmlContent);
      console.log(`✅ HTML prepared: ${processedHTML.length} chars`);

      // Set content with proper wait options
      await page.setContent(processedHTML, {
        waitUntil: 'networkidle0',
        timeout: 120000
      });

      console.log('✅ HTML content loaded');

      // Wait for all fonts and styles to load
      await page.evaluate(() => document.fonts.ready);
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('✅ Page fully rendered');

      // A4 Portrait PDF options
      const pdfOptions = {
        format: 'A4',
        landscape: false,
        printBackground: true,
        margin: {
          top: '5mm',
          right: '5mm',
          bottom: '5mm',
          left: '5mm'
        },
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        timeout: 120000
      };

      console.log('📄 Generating PDF with A4 Portrait options...');
      console.log('PDF Options:', JSON.stringify(pdfOptions, null, 2));

      const pdfBuffer = await page.pdf(pdfOptions);

      console.log(`✅ Overall Report PDF generated: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
      return pdfBuffer;

    } catch (error) {
      console.error('❌ Overall Report PDF generation error:', error.message);
      console.error('Stack:', error.stack);

      // Reset browser on error
      if (browser) {
        try {
          await browser.close();
        } catch (e) { }
        this.browser = null;
        this.initialized = false;
      }

      throw new Error(`Overall PDF generation failed: ${error.message}`);

    } finally {
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error('Error closing page:', e.message);
        }
      }
    }
  }

  /**
   * Prepare HTML specifically for Overall Report PDF
   * Adds special styling for tables, bars, and page breaks
   */
  prepareOverallReportHTML(htmlContent) {
    console.log('🎨 Preparing Overall Report HTML for PDF...');

    let processed = htmlContent;

    // Ensure DOCTYPE
    if (!processed.includes('<!DOCTYPE')) {
      processed = '<!DOCTYPE html>\n' + processed;
    }

    // Ensure complete HTML structure
    if (!processed.includes('<html')) {
      processed = '<html><head><meta charset="UTF-8"></head><body>' + processed + '</body></html>';
    }

    // Add Overall Report specific CSS
    const overallReportCSS = `
    <style>
      /* Reset and base styles */
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 11px;
        line-height: 1.4;
        color: #333;
        background: white;
        padding: 0;
        margin: 0;
      }
      
      /* Page break handling */
      .page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
        margin: 0;
        padding: 0;
      }
      
      /* Cover page specific */
      .cover-page {
        page-break-after: always;
        break-after: page;
      }
      
      /* Table styles for better PDF rendering */
      table {
        border-collapse: collapse;
        width: 100%;
        margin-bottom: 15px;
        page-break-inside: avoid;
      }
      
      th, td {
        border: 1px solid #ddd;
        padding: 8px 6px;
        text-align: left;
        vertical-align: top;
      }
      
      th {
        background-color: #f3f4f6;
        font-weight: bold;
        font-size: 9px;
        text-transform: uppercase;
      }
      
      /* Prevent row breaks inside tables */
      tr {
        page-break-inside: avoid;
        page-break-after: auto;
      }
      
      /* Section headers */
      .section-title {
        font-size: 16px;
        font-weight: bold;
        color: #1e3a8a;
        margin: 20px 0 15px 0;
        padding-bottom: 10px;
        border-bottom: 2px solid #e5e7eb;
        page-break-after: avoid;
      }
      
      /* Legend styles */
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 15px;
        margin: 15px 0;
        padding: 10px 0;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 9px;
      }
      
      .legend-color {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      
      /* Compliance bar styles */
      .compliance-bar {
        display: inline-block;
        height: 12px;
        width: 80px;
        border-radius: 3px;
        overflow: hidden;
        background: #e5e7eb;
      }
      
      .bar-green { background: #22c55e; height: 100%; float: left; }
      .bar-red { background: #ef4444; height: 100%; float: left; }
      .bar-gray { background: #9ca3af; height: 100%; float: left; }
      .bar-amber { background: #f59e0b; height: 100%; float: left; }
      
      /* Text colors */
      .text-green { color: #16a34a; font-weight: bold; }
      .text-red { color: #dc2626; font-weight: bold; }
      .text-gray { color: #6b7280; }
      .text-amber { color: #d97706; font-weight: bold; }
      .text-center { text-align: center; }
      .font-bold { font-weight: bold; }
      
      /* Grid layout for cover page */
      .grid-2x2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        min-height: 500px;
        margin: 20px 0;
      }
      
      .grid-cell {
        padding: 25px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .gray-bg { background: #9ca3af; color: white; }
      .white-bg { background: white; border: 1px solid #f3f4f6; }
      
      /* Keep elements together */
      .keep-together {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      
      /* Force background colors to print */
      * {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      
      /* Responsive images */
      img, svg {
        max-width: 100%;
        height: auto;
      }
    </style>
  `;

    // Add CSS to head
    if (processed.includes('</head>')) {
      processed = processed.replace('</head>', overallReportCSS + '</head>');
    } else if (processed.includes('<body>')) {
      processed = processed.replace('<body>', '<head>' + overallReportCSS + '</head><body>');
    }

    console.log(`📊 HTML processed: ${htmlContent.length} → ${processed.length} chars`);
    return processed;
  }
  prepareHTMLForPDF(htmlContent) {
    console.log('🧹 Preparing HTML for PDF generation...');

    let processed = htmlContent;

    // 1. Ensure DOCTYPE
    if (!processed.includes('<!DOCTYPE')) {
      processed = '<!DOCTYPE html>' + processed;
    }

    // 2. Ensure complete HTML structure
    if (!processed.includes('<html')) {
      processed = '<html><head><meta charset="UTF-8"></head><body>' + processed + '</body></html>';
    }

    // 3. Add CSS for better PDF rendering
    const pdfCSS = `
      <style>
        /* Optimize for PDF printing */
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          font-size: 12px;
          line-height: 1.4;
          color: #333;
          padding: 10px;
        }
        
        /* Page break handling */
        .page-break {
          page-break-after: always;
        }
        
        .avoid-break {
          page-break-inside: avoid;
        }
        
        /* Tables */
        table {
          border-collapse: collapse;
          width: 100%;
          margin-bottom: 10px;
          page-break-inside: auto;
        }
        
        tr {
          page-break-inside: avoid;
          page-break-after: auto;
        }
        
        th, td {
          border: 1px solid #ddd;
          padding: 6px;
          text-align: left;
          vertical-align: top;
          page-break-inside: auto;
        }
        
        /* Images */
        img {
          max-width: 100%;
          height: auto;
        }
        
        /* Custom format specific */
        @media print {
          body {
            font-size: 11px;
          }
        }
      </style>
    `;

    // Add CSS to head
    if (processed.includes('</head>')) {
      processed = processed.replace('</head>', pdfCSS + '</head>');
    } else if (processed.includes('<body>')) {
      processed = processed.replace('<body>', '<head>' + pdfCSS + '</head><body>');
    }

    console.log(`📊 HTML processed: ${htmlContent.length} → ${processed.length} chars`);
    return processed;
  }

  async cleanup() {
    console.log('🧹 Cleaning up PDF service...');
    if (this.browser) {
      try {
        await this.browser.close();
        console.log('✅ Browser closed');
      } catch (error) {
        console.error('❌ Error closing browser:', error);
      }
      this.browser = null;
      this.initialized = false;
      this.initializationPromise = null;
    }
  }
}

// Export instance
const pdfServiceInstance = new PDFService();
export { PDFService };
export default pdfServiceInstance;