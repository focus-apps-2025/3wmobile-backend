import mongoose from 'mongoose';
import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import Response from '../models/Response.js';

/**
 * Send a message to a submitter (inspector)
 */
export const sendMessage = async (req, res) => {
  try {
    const { toEmail, message, responseId, formId, questionIds, questionTitles, questionContexts, tenantId } = req.body;
    
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
    const tenantId = req.user.tenantId;
    
    console.log("[getMessagesByResponse] responseId:", responseId);
    console.log("[getMessagesByResponse] tenantId:", tenantId);
    
    const messages = await ChatMessage.find({ 
      responseId
    })
      .populate('from', 'name email username')
      .populate('toUser', 'name email username')
      .sort({ createdAt: 1 });

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
