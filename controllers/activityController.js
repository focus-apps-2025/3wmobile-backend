// controllers/activityController.js
import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';
import FormSession from '../models/FormSession.js';
import User from '../models/User.js';

/**
 * Get user activity summary for a tenant
 */
export const getTenantActivitySummary = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { startDate, endDate, role } = req.query;

    // Check permissions
    if (req.user.role !== 'superadmin' && req.user.tenantId.toString() !== tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const match = {
      tenantId: new mongoose.Types.ObjectId(tenantId)
    };

    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    if (role) {
      match.userRole = role;
    }

    // Get activity by user
    const userActivity = await ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$userId',
          totalActions: { $sum: 1 },
          heartbeats: {
            $sum: { $cond: [{ $eq: ['$action', 'HEARTBEAT'] }, 1, 0] }
          },
          firstSeen: { $min: '$createdAt' },
          lastSeen: { $max: '$createdAt' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 1,
          userName: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
          email: '$user.email',
          role: '$user.role',
          totalActions: 1,
          heartbeats: 1,
          firstSeen: 1,
          lastSeen: 1,
          activeMinutes: {
            $ceil: {
              $divide: [
                { $subtract: ['$lastSeen', '$firstSeen'] },
                60000
              ]
            }
          }
        }
      },
      { $sort: { totalActions: -1 } }
    ]);

    // Get action breakdown
    const actionBreakdown = await ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      data: {
        users: userActivity,
        actionBreakdown,
        summary: {
          totalUsers: userActivity.length,
          totalActions: userActivity.reduce((sum, u) => sum + u.totalActions, 0)
        }
      }
    });

  } catch (error) {
    console.error('Get tenant activity summary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Get single user timeline
 */
export const getUserTimeline = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, startDate, endDate } = req.query;

    // Check permissions
    if (req.user.role !== 'superadmin' && 
        req.user.role !== 'admin' && 
        req.user._id.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const match = { userId: new mongoose.Types.ObjectId(userId) };

    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    const activities = await ActivityLog.find(match)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Group by session (30 min gaps)
    const sessions = [];
    let currentSession = [];
    
    activities.reverse().forEach(activity => {
      if (currentSession.length === 0) {
        currentSession.push(activity);
      } else {
        const lastActivity = currentSession[currentSession.length - 1];
        const timeDiff = activity.createdAt - lastActivity.createdAt;
        
        if (timeDiff < 30 * 60 * 1000) { // 30 minutes
          currentSession.push(activity);
        } else {
          sessions.push([...currentSession]);
          currentSession = [activity];
        }
      }
    });
    
    if (currentSession.length > 0) {
      sessions.push(currentSession);
    }

    res.json({
      success: true,
      data: {
        activities,
        sessions: sessions.map(s => ({
          start: s[0].createdAt,
          end: s[s.length - 1].createdAt,
          duration: Math.floor((s[s.length - 1].createdAt - s[0].createdAt) / 1000),
          actions: s.length
        }))
      }
    });

  } catch (error) {
    console.error('Get user timeline error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Get form filling analytics
 */
export const getFormFillingAnalytics = async (req, res) => {
  try {
    const { formId } = req.params;
    const { startDate, endDate } = req.query;

    const match = { formId };

    if (startDate || endDate) {
      match.startedAt = {};
      if (startDate) match.startedAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        match.startedAt.$lte = end;
      }
    }

    const sessions = await FormSession.find(match)
      .populate('userId', 'firstName lastName email role')
      .sort({ startedAt: -1 })
      .lean();

    // Calculate statistics
    const completedSessions = sessions.filter(s => s.status === 'completed');
    const times = completedSessions.map(s => s.timeSpent).filter(t => t > 0);

    const stats = {
      totalSessions: sessions.length,
      completed: completedSessions.length,
      inProgress: sessions.filter(s => s.status === 'in-progress').length,
      abandoned: sessions.filter(s => s.status === 'abandoned').length,
      avgTimeSpent: times.length > 0 
        ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        : 0,
      minTime: times.length > 0 ? Math.min(...times) : 0,
      maxTime: times.length > 0 ? Math.max(...times) : 0
    };

    // Question-level analytics
    const questionStats = {};
    sessions.forEach(session => {
      if (session.questionTimings) {
        session.questionTimings.forEach(q => {
          if (!questionStats[q.questionId]) {
            questionStats[q.questionId] = {
              questionId: q.questionId,
              questionText: q.questionText,
              times: [],
              answers: []
            };
          }
          if (q.timeSpent) {
            questionStats[q.questionId].times.push(q.timeSpent);
          }
          if (q.answer) {
            questionStats[q.questionId].answers.push(q.answer);
          }
        });
      }
    });

    // Calculate averages for questions
    Object.values(questionStats).forEach(q => {
      q.avgTime = q.times.length > 0 
        ? Math.round(q.times.reduce((a, b) => a + b, 0) / q.times.length)
        : 0;
      q.responseCount = q.times.length;
    });

    res.json({
      success: true,
      data: {
        statistics: stats,
        sessions: sessions.slice(0, 20), // Last 20 sessions
        questionAnalytics: Object.values(questionStats)
      }
    });

  } catch (error) {
    console.error('Get form filling analytics error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Calculate active minutes for a user (enhanced version)
 */
export const calculateUserActiveMinutes = async (userId, tenantId, startDate, endDate) => {
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  const activities = await ActivityLog.find({
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(tenantId),
    createdAt: {
      $gte: startDate || new Date(0),
      $lte: endDate || new Date()
    }
  }).sort({ createdAt: 1 }).lean();

  if (activities.length === 0) return 0;

  let totalMinutes = 0;
  let sessionStart = activities[0].createdAt;
  let lastActivity = activities[0].createdAt;

  for (let i = 1; i < activities.length; i++) {
    const current = activities[i].createdAt;
    const gap = current - lastActivity;

    if (gap <= SESSION_TIMEOUT) {
      lastActivity = current;
    } else {
      // Session ended
      const sessionMinutes = Math.ceil((lastActivity - sessionStart) / 60000);
      totalMinutes += Math.max(sessionMinutes, 1); // ✅ Minimum 1 minute
      
      sessionStart = current;
      lastActivity = current;
    }
  }

  // Add last session
  const lastSessionMinutes = Math.ceil((lastActivity - sessionStart) / 60000);
  totalMinutes += Math.max(lastSessionMinutes, 1); // ✅ Minimum 1 minute

  return totalMinutes;
};