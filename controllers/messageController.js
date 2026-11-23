import mongoose from 'mongoose';
import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import Response from '../models/Response.js';
import Form from '../models/Form.js';

/**
 * Send a message to a submitter (inspector)
 */
export const sendMessage = async (req, res) => {
  try {
    const { toEmail, message, responseId, formId, questionIds, questionTitles, questionContexts, tenantId } = req.body;
    
    // Validation: If chassis has assigned tenants, chat must arise from assigned tenant, form owner, or admin.
    // Other tenants can only reply once a message or review feedback has arisen.
    if (responseId && req.user.role !== 'superadmin') {
      const isRespObjId = mongoose.Types.ObjectId.isValid(responseId);
      const resp = await Response.findOne({
        $or: [
          { id: responseId },
          ...(isRespObjId ? [{ _id: new mongoose.Types.ObjectId(responseId) }] : [])
        ]
      });
      if (resp) {
        const targetFormId = resp.formId || resp.questionId || formId;
        const isFormObjId = targetFormId && mongoose.Types.ObjectId.isValid(targetFormId);
        const form = targetFormId
          ? await Form.findOne({
              $or: [
                { id: targetFormId },
                ...(isFormObjId ? [{ _id: new mongoose.Types.ObjectId(targetFormId) }] : [])
              ]
            })
          : null;
        if (form && Array.isArray(form.chassisTenantAssignments) && form.chassisTenantAssignments.length > 0) {
          const respChassis = String(
            resp.chassisNumber ||
            (resp.answers instanceof Map ? resp.answers.get('chassis_number') || resp.answers.get('chassisNumber') : resp.answers?.chassis_number || resp.answers?.chassisNumber) ||
            ''
          ).trim().toLowerCase();
          const assignment = form.chassisTenantAssignments.find(
            a => a.chassisNumber && respChassis && String(a.chassisNumber).trim().toLowerCase() === respChassis
          );
          if (assignment && Array.isArray(assignment.assignedTenants) && assignment.assignedTenants.length > 0) {
            const userTenantStr = req.user.tenantId ? req.user.tenantId.toString() : '';
            const isAssignedTenant = assignment.assignedTenants.some(t => t.toString() === userTenantStr);
            const isFormOwner = (form.tenantId && form.tenantId.toString() === userTenantStr);
            const isSharedTenant = Array.isArray(form.sharedWithTenants) && form.sharedWithTenants.some(t => String(t?._id || t?.id || t) === userTenantStr);
            const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';

            if (!isAssignedTenant && !isFormOwner && !isSharedTenant && !isAdmin) {
              const existingMsgCount = await ChatMessage.countDocuments({ responseId });
              const hasReviewArisen = Boolean(resp.biwReview?.status || resp.review?.status || resp.review?.message);
              if (existingMsgCount === 0 && !hasReviewArisen) {
                return res.status(403).json({
                  success: false,
                  message: 'Chat must be initiated by the assigned tenant reviewer. You can reply once a discussion or review feedback has been posted.'
                });
              }
            }
          }
        }
      }
    }

    // Check if toEmail is actually a valid ObjectId (meaning frontend sent user ID)
    let receiver = null;
    let finalToEmail = toEmail;
    
    if (toEmail && typeof toEmail === 'string' && toEmail.match(/^[0-9a-fA-F]{24}$/)) {
      receiver = await User.findById(toEmail);
      if (receiver) {
        finalToEmail = receiver.email;
      }
    } else {
      // Look for a user with this email to link toUser if possible
      receiver = await User.findOne({ email: toEmail });
    }
    
    const newMessage = new ChatMessage({
      from: req.user._id,
      toEmail: finalToEmail,
      toUser: receiver ? receiver._id : null,
      message,
      responseId,
      formId,
      questionIds,
      questionTitles,
      questionContexts,
      tenantId: tenantId || req.user.tenantId
    });

    await newMessage.save();
    console.log("[sendMessage] Created message with formId:", formId);

    res.status(201).json({ success: true, data: newMessage });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get message history for a specific response
 */
export const getMessagesByResponse = async (req, res) => {
  try {
    const { responseId } = req.params;
    
    console.log("[getMessagesByResponse] responseId:", responseId);
    
    // Support matching by string UUID id, ObjectId _id, or mapped parent/child response
    const allResponseIds = [responseId];
    let mainResp = null;
    let pairedResp = null;

    try {
      mainResp = mongoose.Types.ObjectId.isValid(responseId)
        ? await Response.findById(responseId).lean()
        : await Response.findOne({ id: responseId }).lean();

      if (mainResp) {
        if (mainResp.id) allResponseIds.push(String(mainResp.id));
        if (mainResp._id) allResponseIds.push(String(mainResp._id));

        // If this response is a child pointing to a parent
        if (mainResp.parentResponseId) {
          allResponseIds.push(String(mainResp.parentResponseId));
          pairedResp = mongoose.Types.ObjectId.isValid(mainResp.parentResponseId)
            ? await Response.findById(mainResp.parentResponseId).lean()
            : await Response.findOne({ id: mainResp.parentResponseId }).lean();
        }

        // If this response is a parent having child responses
        if (!pairedResp) {
          pairedResp = await Response.findOne({
            parentResponseId: { $in: [String(mainResp._id), String(mainResp.id)].filter(Boolean) }
          }).lean();
        }

        if (pairedResp) {
          if (pairedResp.id) allResponseIds.push(String(pairedResp.id));
          if (pairedResp._id) allResponseIds.push(String(pairedResp._id));
        }
      }
    } catch (e) {
      console.warn('[getMessagesByResponse] Error resolving paired response:', e.message);
    }

    const uniqueIds = [...new Set(allResponseIds.filter(Boolean))];

    let messages = await ChatMessage.find({ 
      responseId: { $in: uniqueIds }
    })
      .populate('from', 'name email username firstName lastName')
      .populate('toUser', 'name email username firstName lastName')
      .sort({ createdAt: 1 })
      .lean();

    // If no chat messages found, synthesize opening review messages for both responses if available
    if (messages.length === 0 && (mainResp || pairedResp)) {
      try {
        const synthFromReview = async (r, labelPrefix) => {
          const curRev = r?.review;
          const revMsg = curRev?.remark || curRev?.reason || curRev?.message;
          if (!curRev || !revMsg) return null;

          const reviewerId = curRev.reviewedBy;
          let reviewerDoc = null;
          if (reviewerId && mongoose.Types.ObjectId.isValid(reviewerId)) {
            reviewerDoc = await User.findById(reviewerId).select('firstName lastName username email').lean();
          }
          const reviewerName = reviewerDoc
            ? `${reviewerDoc.firstName || ''} ${reviewerDoc.lastName || ''}`.trim() || reviewerDoc.username || reviewerDoc.email
            : (curRev.reviewedByName || curRev.reviewer || 'Reviewer');

          return {
            _id: 'rev-auto-init-' + String(r._id || r.id),
            responseId: String(r.id || r._id),
            from: {
              _id: reviewerId,
              name: reviewerName,
              email: reviewerDoc?.email || ''
            },
            message: `${labelPrefix ? `[${labelPrefix}] ` : ''}${revMsg}`,
            questionTitles: Array.isArray(curRev.flaggedQuestions)
              ? curRev.flaggedQuestions.map(q => typeof q === 'object' ? q.questionText || q.title || q.text || q.questionId : String(q))
              : [],
            questionContexts: Array.isArray(curRev.flaggedQuestions)
              ? curRev.flaggedQuestions.map(q => ({
                  questionId: typeof q === 'object' ? q.questionId || q.id : String(q),
                  title: typeof q === 'object' ? q.questionText || q.title || q.text : String(q)
                }))
              : [],
            createdAt: curRev.reviewedAt || r.updatedAt || new Date(),
            isReviewFeedback: true,
            reviewOption: curRev.reviewOption || curRev.status
          };
        };

        const synthMessages = [];
        if (pairedResp) {
          const m = await synthFromReview(pairedResp, '1st Form');
          if (m) synthMessages.push(m);
        }
        if (mainResp) {
          const m = await synthFromReview(mainResp, pairedResp ? '2nd Form' : '');
          if (m) synthMessages.push(m);
        }
        if (synthMessages.length > 0) {
          messages = synthMessages;
        }
      } catch (synthErr) {
        console.warn('[getMessagesByResponse] Synthesizing review messages failed:', synthErr.message);
      }
    }

    console.log("[getMessagesByResponse] Found messages:", messages.length);
    res.json({ success: true, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all messages for the current user (inspector role)
 */
export const getMyMessages = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userIdStr = req.user._id.toString();
    
    console.log("[getMyMessages] userEmail:", userEmail);
    console.log("[getMyMessages] userId:", userIdStr);
    
    const messages = await ChatMessage.find({ 
      $or: [
        { toEmail: userEmail },
        { toEmail: userIdStr },
        { toUser: req.user._id },
        { from: req.user._id }
      ]
    })
      .populate('from', 'name email username')
      .sort({ createdAt: -1 });

    console.log("[getMyMessages] Found messages:", messages.length);
    
    res.json({ success: true, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all messages for the tenant (all users in tenant can see all messages)
 */
export const getTenantMessages = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    
    console.log("[getTenantMessages] tenantId:", tenantId);
    
    const messages = await ChatMessage.find({ tenantId })
      .populate('from', 'name email username firstName lastName')
      .sort({ createdAt: -1 })
      .limit(500);

    console.log("[getTenantMessages] Found messages:", messages.length);

    // Manually attach responses because responseId can be either custom string ID (id) or ObjectId (_id)
    const responseIds = [...new Set(messages.map(m => m.responseId))].filter(Boolean);
    const objectIds = responseIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    const findQuery = {
      $or: [
        { id: { $in: responseIds } },
        { _id: { $in: objectIds } }
      ]
    };
    const responses = await Response.find(findQuery);
    const responseMap = responses.reduce((acc, r) => {
      acc[r.id] = r;
      acc[r._id.toString()] = r;
      return acc;
    }, {});

    const messagesWithResponses = messages.map(m => {
      const msgObj = m.toObject();
      msgObj.responseId = responseMap[m.responseId] || m.responseId;
      return msgObj;
    });
    
    res.json({ success: true, data: messagesWithResponses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Reply to a message
 */
export const replyToMessage = async (req, res) => {
  try {
    const { parentMessageId, message } = req.body;
    
    const parentMsg = await ChatMessage.findById(parentMessageId);
    if (!parentMsg) {
      return res.status(404).json({ success: false, message: 'Parent message not found' });
    }

    const reply = new ChatMessage({
      from: req.user._id,
      toEmail: parentMsg.from.email || '', // We'll need to populate the parentMsg.from
      toUser: parentMsg.from,
      message,
      responseId: parentMsg.responseId,
      questionIds: parentMsg.questionIds,
      isReply: true,
      parentMessageId,
      tenantId: req.user.tenantId
    });

    // Populate toEmail from the sender of the parent message
    const originalSender = await User.findById(parentMsg.from);
    if (originalSender) {
      reply.toEmail = originalSender.email;
    }

    await reply.save();

    res.status(201).json({ success: true, data: reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Fix messages with broken toEmail ([object Object])
 */
export const fixMessagesToEmail = async (req, res) => {
  try {
    // Find messages with broken toEmail
    const brokenMessages = await ChatMessage.find({ toEmail: '[object Object]' });
    console.log("[fixMessagesToEmail] Found broken messages:", brokenMessages.length);
    
    let fixed = 0;
    for (const msg of brokenMessages) {
      // Try to find the user by matching tenantId and the stored user reference
      const tenantId = req.user.tenantId;
      const users = await User.find({ tenantId });
      
      for (const user of users) {
        // Check if the user might be the recipient by checking if their ID appears anywhere
        // This is a heuristic - ideally we'd need better tracking
      }
    }
    
    // For now, just delete the broken messages
    const result = await ChatMessage.deleteMany({ toEmail: '[object Object]' });
    console.log("[fixMessagesToEmail] Deleted:", result.deletedCount);
    
    res.json({ success: true, message: `Deleted ${result.deletedCount} broken messages` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
