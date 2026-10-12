import "./config/env.js";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import cors from "cors";
import compression from "compression";
import { createServer } from "http";
import connectDB from "./config/database.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import formRoutes from "./routes/formRoutes.js";
import responseRoutes from "./routes/responseRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import fileRoutes from "./routes/fileRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import analyticsInviteRoutes from "./routes/analyticsInviteRoutes.js";
import roleRoutes from "./routes/roleRoutes.js";
import mailRoutes from "./routes/mailRoutes.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import tenantRoutes from "./routes/tenantRoutes.js";
import parameterRoutes from "./routes/parameterRoutes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { handleUploadError } from "./middleware/upload.js";
import { initializeSocket } from "./socket/socketHandler.js";
import pdfService from './services/pdfService.js';  // Add this for cleanup
import pdfRoutes from './routes/pdfRoutes.js';
import githubWebhookRoutes from "./routes/githubWebhook.js";
import formInviteRoutes from './routes/formInviteRoutes.js';

import uploadRoutes from './routes/upload.js';
import activityRoutes from './routes/activityRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import otpRoutes from './routes/otpRoutes.js';
import hrRoutes from './routes/hrRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import internalTrackingRoutes from './routes/internalTrackingRoutes.js';
import importHistoryRoutes from './routes/importHistoryRoutes.js';
import { initKeepAlive } from './utils/keepAlive.js';

// Connect to database safely without crashing startup
try {
  await connectDB();
} catch (dbErr) {
  console.error("⚠️ Database initial connection failed:", dbErr.message || dbErr);
}

// Initialize AutoSend cron job (skip in serverless)
import { initAutoSendJob } from './services/autoSendService.js';
import { startPermissionCron } from './scripts/permissionCron.js';
if (!process.env.VERCEL) {
  try {
    initAutoSendJob();
    startPermissionCron();
  } catch (cronErr) {
    console.error("⚠️ Cron job init failed:", cronErr.message || cronErr);
  }
}

const app = express();

// Set server timeout for file uploads (default 10 minutes, configurable via env)
const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT || '600000');
app.timeout = requestTimeout;

// Parse FRONTEND_URL to handle multiple origins
const allowedOrigins = [
  "https://servicerequests.netlify.app",
  "https://formsadmin.netlify.app",
  "https://formsuperadmin.focusengineeringapp.com",
  "https://3wheelertvs.focusengineeringapp.com",
  "https://focus3rdeye.netlify.app",
  "https://threew-wheeler-backend.onrender.com",
  ...(process.env.CLOUDFRONT_URL ? [process.env.CLOUDFRONT_URL] : []),
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(url => url.trim()) : [])
];

// Add localhost origins for development
const developmentOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://localhost:5173", // Vite default
  "http://localhost:5174", // Vite alternate port
  "http://127.0.0.1:5174",
  "http://localhost:8080", // Some dev servers
];

// Explicit CORS & Preflight OPTIONS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-App-Type');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours to eliminate OPTIONS lag
  }
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Fallback cors middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    callback(null, true);
  },
  credentials: true,
  maxAge: 86400
}));

// Gzip compression — reduces JSON payloads by ~90% (20MB → ~2MB)
app.use(compression({
  level: 6,
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(
  "/api/github-webhook",
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
  })
);

app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

// Ensure database is connected for every request (critical for serverless / Vercel)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (dbErr) {
    console.error("DB connection error in request middleware:", dbErr.message || dbErr);
    next(dbErr);
  }
});

app.use('/api/upload', uploadRoutes);



// Ultra-fast health check for keep-alive pinging (no auth, no middleware)
app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Health check route
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: " Backend API is running 🚀",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Ignore browser favicon requests
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Serve uploaded files (fallback for any local uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/responses", responseRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/analytics-invites", (req, res, next) => {
  // Set a much higher timeout (10 minutes) for analytics invites specifically 
  // because PDF generation with Puppeteer can be extremely slow
  req.setTimeout(600000); 
  next();
}, analyticsInviteRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/parameters", parameterRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/forms', formInviteRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/otp', otpRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/internal-tracking', internalTrackingRoutes);
app.use('/api/import-history', importHistoryRoutes);


process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning up...');
  await pdfService.cleanup();  // ✅ FIXED: lowercase
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Cleaning up...');
  await pdfService.cleanup();  // ✅ FIXED: lowercase
  process.exit(0);
});


app.use("/api/github-webhook", githubWebhookRoutes);

// API info route
app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "Little Flower School API - Complete Form Management System",
    version: "1.0.0",
    endpoints: {
      auth: {
        login: "POST /api/auth/login",
        profile: "GET /api/auth/profile",
        changePassword: "PUT /api/auth/change-password"
      },
      users: {
        create: "POST /api/users",
        getAll: "GET /api/users",
        getById: "GET /api/users/:id",
        update: "PUT /api/users/:id",
        delete: "DELETE /api/users/:id",
        resetPassword: "PUT /api/users/:id/reset-password"
      },
      forms: {
        create: "POST /api/forms",
        getAll: "GET /api/forms",
        getPublic: "GET /api/forms/public",
        getById: "GET /api/forms/:id",
        update: "PUT /api/forms/:id",
        delete: "DELETE /api/forms/:id",
        updateVisibility: "PATCH /api/forms/:id/visibility",
        duplicate: "POST /api/forms/:id/duplicate",
        analytics: "GET /api/forms/:id/analytics"
      },
      responses: {
        create: "POST /api/responses",
        getAll: "GET /api/responses",
        getById: "GET /api/responses/:id",
        update: "PUT /api/responses/:id",
        assign: "PATCH /api/responses/:id/assign",
        delete: "DELETE /api/responses/:id",
        deleteMultiple: "DELETE /api/responses",
        byForm: "GET /api/responses/form/:formId",
        export: "GET /api/responses/form/:formId/export"
      },
      profile: {
        get: "GET /api/profile",
        update: "PUT /api/profile",
        updateSettings: "PATCH /api/profile/settings",
        uploadAvatar: "POST /api/profile/avatar"
      },
      files: {
        upload: "POST /api/files/upload",
        get: "GET /api/files/:filename",
        delete: "DELETE /api/files/:id",
        getByUser: "GET /api/files",
        getInfo: "GET /api/files/info/:id"
      },
      analytics: {
        dashboard: "GET /api/analytics/dashboard",
        form: "GET /api/analytics/form/:formId",
        users: "GET /api/analytics/users",
        export: "GET /api/analytics/export"
      },
      roles: {
        create: "POST /api/roles",
        getAll: "GET /api/roles",
        getById: "GET /api/roles/:id",
        update: "PUT /api/roles/:id",
        delete: "DELETE /api/roles/:id",
        assign: "POST /api/roles/assign",
        getUsersByRole: "GET /api/roles/:roleId/users",
        permissions: "GET /api/roles/permissions"
      },
      mail: {
        testConnection: "GET /api/mail/test-connection",
        sendTestEmail: "POST /api/mail/test-email",
        serviceRequestNotification: "POST /api/mail/service-request-notification",
        statusUpdate: "POST /api/mail/status-update"
      },
      whatsapp: {
        testConnection: "GET /api/whatsapp/test-connection",
        sendTestMessage: "POST /api/whatsapp/test-message",
        serviceRequestNotification: "POST /api/whatsapp/service-request-notification",
        statusUpdate: "POST /api/whatsapp/status-update",
        sendResponseReport: "POST /api/whatsapp/send-response-report"
      },
      parameters: {
        create: "POST /api/parameters",
        getAll: "GET /api/parameters",
        getById: "GET /api/parameters/:id",
        update: "PUT /api/parameters/:id",
        delete: "DELETE /api/parameters/:id"
      },
      pdf: {
        generate: "POST /api/pdf/generate"
      }
    }
  });
});

// Frontend is served by Vercel — no catch-all needed

// Handle upload errors
app.use(handleUploadError);

// Error handling middleware
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Create HTTP server
const httpServer = createServer(app);

// Set socket and request timeout
httpServer.setTimeout(requestTimeout);
httpServer.keepAliveTimeout = requestTimeout + 30000;

// Initialize Socket.IO
const io = initializeSocket(httpServer);
app.set('io', io);

export default app;

if (!process.env.VERCEL) {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
    console.log(`⏱️  Request timeout: ${requestTimeout}ms (${Math.round(requestTimeout / 1000 / 60)} minutes)`);
    console.log(`🔌 WebSocket server initialized for real-time updates`);

    // Start keep-alive pinger to prevent Render cold starts
    if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
      initKeepAlive();
    }
  });
}