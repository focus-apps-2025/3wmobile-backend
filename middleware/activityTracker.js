// middleware/activityTracker.js
import ActivityLog from '../models/ActivityLog.js';
import FormSession from '../models/FormSession.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Track any user action automatically from API requests
 */
export const trackAction = (action, options = {}) => {
  return async (req, res, next) => {
    // Store original end function
    const originalEnd = res.end;
    let responseSent = false;

    res.end = function (chunk, encoding) {
      if (!responseSent && req.user && req.user._id) {
        responseSent = true;

        // Determine resource ID from request
        let resourceId = null;
        let resourceType = options.resourceType || null;

        if (req.params.id) resourceId = req.params.id;
        else if (req.params.formId) {
          resourceId = req.params.formId;
          resourceType = 'form';
        } else if (req.params.responseId) {
          resourceId = req.params.responseId;
          resourceType = 'response';
        } else if (req.params.userId) {
          resourceId = req.params.userId;
          resourceType = 'user';
        }

        // Create activity log (non-blocking)
        ActivityLog.create({
          userId: req.user._id,
          tenantId: req.user.tenantId || req.user._id.toString(),
          userRole: req.user.role,
          action: action,
          resourceId: resourceId,
          resourceType: resourceType,
          metadata: {
            method: req.method,
            path: req.path,
            query: req.query,
            statusCode: res.statusCode,
            ...options.metadata
          },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          sessionId: req.sessionID
        }).catch(err => console.error('Failed to save activity log:', err));
      }

      originalEnd.call(this, chunk, encoding);
    };

    next();
  };
};

/**
 * Track form start
 */
export const trackFormStart = async (req, res, next) => {
  try {
    if (req.params.id) {
      const formId = req.params.id;
      const sessionId = uuidv4();

      req.formStartTime = new Date();
      req.formSessionId = sessionId;

      // Get form title from request body or fetch from DB
      let formTitle = req.body.formTitle || 'Unknown Form';

      // Handle tenantId for public users
      let tenantId = req.user?.tenantId || req.tenantId;
      if (!tenantId) {
        try {
          const Form = mongoose.model('Form');
          // Important: check both MongoDB _id and custom string id
          const form = await Form.findOne({
            $or: [
              { id: formId },
              ...(mongoose.Types.ObjectId.isValid(formId) ? [{ _id: formId }] : [])
            ]
          }).select('tenantId title');

          if (form) {
            tenantId = form.tenantId;
            if (!formTitle || formTitle === 'Unknown Form') {
              formTitle = form.title;
            }
          }
        } catch (err) {
          console.error('Error finding form tenant:', err);
        }
      }

      if (!tenantId) {
        console.warn(`[TRACKING] Could not determine tenantId for form ${formId}. Session might not be saved.`);
      }

      // Create form session
      const session = new FormSession({
        sessionId,
        userId: req.user?._id || null, // Allow null for anonymous
        tenantId: tenantId,
        userRole: req.user?.role || 'anonymous',
        formId,
        formTitle,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        status: 'in-progress',
        metadata: {
          userAgent: req.get('User-Agent'),
          ipAddress: req.ip,
          deviceType: typeof detectDevice === 'function' ? detectDevice(req.get('User-Agent')) : 'unknown'
        }
      });

      await session.save();

      // Store sessionId in request for later use
      req.formSessionId = sessionId;

      // Log the action
      if (req.user?._id) {
        await ActivityLog.create({
          userId: req.user._id,
          tenantId: req.user.tenantId || tenantId,
          userRole: req.user.role,
          action: 'START_FORM',
          resourceId: formId,
          resourceType: 'form',
          metadata: { sessionId, formTitle },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        }).catch(err => console.error('Failed to log START_FORM activity:', err));
      }
    }
  } catch (error) {
    console.error('Error tracking form start:', error);
  }

  next();
};

/**
 * Track question time
 */
export const trackQuestionTime = async (req, res, next) => {
  try {
    const { sessionId, questionId, questionText, questionType, sectionId, sectionTitle, timeSpent, answer } = req.body;

    if (sessionId && questionId) {
      await FormSession.findOneAndUpdate(
        { sessionId },
        {
          $push: {
            questionTimings: {
              questionId,
              questionText,
              questionType,
              sectionId,
              sectionTitle,
              startedAt: new Date(Date.now() - timeSpent * 1000),
              endedAt: new Date(),
              timeSpent,
              answer
            }
          },
          $set: { lastActivityAt: new Date() }
        }
      );
    }
  } catch (error) {
    console.error('Error tracking question time:', error);
  }

  next();
};

/**
 * Track section time
 */
export const trackSectionTime = async (req, res, next) => {
  try {
    const { sessionId, sectionId, sectionTitle, timeSpent, questionCount } = req.body;

    if (sessionId && sectionId) {
      await FormSession.findOneAndUpdate(
        { sessionId },
        {
          $push: {
            sectionTimings: {
              sectionId,
              sectionTitle,
              startedAt: new Date(Date.now() - timeSpent * 1000),
              endedAt: new Date(),
              timeSpent,
              questionCount
            }
          },
          $set: { lastActivityAt: new Date() }
        }
      );
    }
  } catch (error) {
    console.error('Error tracking section time:', error);
  }

  next();
};

/**
 * Track form completion
 */
export const trackFormComplete = async (req, res, next) => {
  try {
    const { sessionId, answers } = req.body;
    const formId = req.params.id || req.params.formId;

    if (sessionId) {
      const session = await FormSession.findOne({ sessionId });

      if (session) {
        const completedAt = new Date();
        const totalTimeSpent = Math.floor((completedAt - session.startedAt) / 1000);

        await FormSession.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              completedAt,
              lastActivityAt: completedAt,
              timeSpent: totalTimeSpent,
              status: 'completed',
              answers: answers || {}
            }
          }
        );

        // Log completion - only if user is authenticated or it was a tracked session
        if (req.user || session.userId) {
          await ActivityLog.create({
            userId: req.user?._id || session.userId,
            tenantId: req.user?.tenantId || session.tenantId,
            userRole: req.user?.role || session.userRole || 'anonymous',
            action: 'COMPLETE_FORM',
            resourceId: formId,
            resourceType: 'form',
            metadata: { sessionId, timeSpent: totalTimeSpent },
            duration: totalTimeSpent,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
          });
        }
      }
    }
  } catch (error) {
    console.error('Error tracking form completion:', error);
  }

  next();
};

/**
 * Heartbeat endpoint for continuous tracking
 */
export const recordHeartbeat = async (req, res) => {
  try {
    const { url, sessionId } = req.body;

    if (req.user && req.user._id) {
      // Handle tenantId for different user roles (superadmin may not have tenantId)
      const tenantId = req.user.tenantId || req.user._id.toString();

      await ActivityLog.create({
        userId: req.user._id,
        tenantId: tenantId,
        userRole: req.user.role,
        action: 'HEARTBEAT',
        metadata: { url },
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        sessionId: sessionId || req.sessionID
      });

      // Update form session if active
      if (req.body.formSessionId) {
        await FormSession.findOneAndUpdate(
          { sessionId: req.body.formSessionId },
          { lastActivityAt: new Date() }
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Helper function to detect device type
function detectDevice(userAgent) {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile')) return 'mobile';
  if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  return 'desktop';
}