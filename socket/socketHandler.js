import { Server } from 'socket.io';

let io;

export const initializeSocket = (server) => {
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

  const developmentOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://localhost:8080",
    "http://127.0.0.1:8080"
  ];

  const allOrigins = [...allowedOrigins, ...developmentOrigins].map(url => url.replace(/\/$/, ""));

  io = new Server(server, {
    cors: {
      origin: function (origin, callback) {
        if (!origin) {
          return callback(null, true);
        }
        const cleanOrigin = origin.replace(/\/$/, "");
        if (
          allOrigins.includes(cleanOrigin) ||
          cleanOrigin.endsWith(".focusengineeringapp.com") ||
          cleanOrigin.endsWith(".netlify.app") ||
          cleanOrigin.endsWith(".cloudfront.net") ||
          cleanOrigin === "https://focusengineeringapp.com"
        ) {
          callback(null, true);
        } else {
          console.warn(`🚫 Socket.IO CORS blocked: ${origin}`);
          callback(null, false);
        }
      },
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-tenant-id', 'X-Tenant-Id', 'x-session-id', 'X-Session-Id', 'x-app-type', 'X-App-Type'],
      allowEIO3: true
    }
  });

  io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    // Join a specific form analytics room
    socket.on('join-form-analytics', (formId) => {
      socket.join(`form-analytics-${formId}`);
      console.log(`📊 Client ${socket.id} joined analytics room for form: ${formId}`);
    });

    // Leave a specific form analytics room
    socket.on('leave-form-analytics', (formId) => {
      socket.leave(`form-analytics-${formId}`);
      console.log(`📊 Client ${socket.id} left analytics room for form: ${formId}`);
    });

    // Join dashboard analytics room
    socket.on('join-dashboard-analytics', () => {
      socket.join('dashboard-analytics');
      console.log(`📊 Client ${socket.id} joined dashboard analytics room`);
    });

    // Leave dashboard analytics room
    socket.on('leave-dashboard-analytics', () => {
      socket.leave('dashboard-analytics');
      console.log(`📊 Client ${socket.id} left dashboard analytics room`);
    });

    // Join submission progress room
    socket.on('join-submission', (submissionId) => {
      socket.join(`submission-${submissionId}`);
      console.log(`📤 Client ${socket.id} joined submission room: ${submissionId}`);
    });

    // Leave submission progress room
    socket.on('leave-submission', (submissionId) => {
      socket.leave(`submission-${submissionId}`);
      console.log(`📤 Client ${socket.id} left submission room: ${submissionId}`);
    });

    socket.on('disconnect', () => {
      console.log('❌ Client disconnected:', socket.id);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};

// Emit events for real-time updates
export const emitResponseCreated = (formId, response) => {
  if (io) {
    // Emit to specific form analytics room
    io.to(`form-analytics-${formId}`).emit('response-created', {
      formId,
      response,
      timestamp: new Date()
    });

    // Also emit to dashboard analytics
    io.to('dashboard-analytics').emit('response-created', {
      formId,
      response,
      timestamp: new Date()
    });

    console.log(`🔔 Emitted response-created event for form: ${formId}`);
  }
};

export const emitResponseUpdated = (formId, response) => {
  if (io) {
    // Emit to specific form analytics room
    io.to(`form-analytics-${formId}`).emit('response-updated', {
      formId,
      response,
      timestamp: new Date()
    });

    // Also emit to dashboard analytics
    io.to('dashboard-analytics').emit('response-updated', {
      formId,
      response,
      timestamp: new Date()
    });

    console.log(`🔔 Emitted response-updated event for form: ${formId}`);
  }
};

export const emitResponseDeleted = (formId, responseId) => {
  if (io) {
    // Emit to specific form analytics room
    io.to(`form-analytics-${formId}`).emit('response-deleted', {
      formId,
      responseId,
      timestamp: new Date()
    });

    // Also emit to dashboard analytics
    io.to('dashboard-analytics').emit('response-deleted', {
      formId,
      responseId,
      timestamp: new Date()
    });

    console.log(`🔔 Emitted response-deleted event for form: ${formId}`);
  }
};

export const emitBatchImported = (formId, data = {}) => {
  if (io) {
    const fId = String(formId);
    // Emit to specific form analytics room
    io.to(`form-analytics-${fId}`).emit('batch-imported', {
      formId: fId,
      ...data,
      timestamp: new Date()
    });

    // Also emit to dashboard analytics
    io.to('dashboard-analytics').emit('batch-imported', {
      formId: fId,
      ...data,
      timestamp: new Date()
    });

    console.log(`🔔 Emitted batch-imported event for form: ${fId}, count: ${data.count || 0}`);
  }
};

export const emitImageProgress = (submissionId, status) => {
  if (io) {
    io.to(`submission-${submissionId}`).emit('image-progress', {
      submissionId,
      status,
      timestamp: new Date()
    });
    console.log(`🖼️ Image progress: ${submissionId} - ${status.message}`);
  }
};