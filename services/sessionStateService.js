import { getSessionBySessionId, updateSession } from '../models/sessionModel.js';
import { getMessagesBySessionId } from '../models/messageModel.js';

/**
 * Session State Service
 * Manages in-memory session state following the ChatSession model
 * Falls back to database for persistence
 * 
 * Enhanced with conversation tracking for intent-aware flow:
 * - lastBotQuestion: Last question asked by bot
 * - lastExpectedField: Field the bot was asking about
 * - answeredFields: Array of fields that have been answered
 * - confidenceByField: Confidence scores for extracted fields
 * - conversationMode: Current conversation state (INTAKE, CLARIFICATION, OFF_TOPIC, SECURITY_WARNING, CONFIRMATION)
 */

// Conversation modes for state tracking
export const CONVERSATION_MODE = {
  INTAKE: 'INTAKE',              // Normal information collection
  CLARIFICATION: 'CLARIFICATION', // Bot clarifying or user asking for clarification
  OFF_TOPIC: 'OFF_TOPIC',        // User went off-topic, redirecting
  SECURITY_WARNING: 'SECURITY_WARNING', // Sensitive data detected, warning shown
  CONFIRMATION: 'CONFIRMATION'   // Showing summary before submission
};

// In-memory session store (for production, consider Redis)
const sessionStore = new Map();

// Session timeout: 30 minutes of inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Clean up expired sessions
 */
const cleanupExpiredSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of sessionStore.entries()) {
    if (session.expiresAt && session.expiresAt < now) {
      sessionStore.delete(sessionId);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

/**
 * Load session state from database or memory
 */
export const loadSessionState = async (sessionId) => {
  // Check memory first
  if (sessionStore.has(sessionId)) {
    const session = sessionStore.get(sessionId);
    if (session.expiresAt && session.expiresAt > Date.now()) {
      return session;
    } else {
      // Expired, remove from memory
      sessionStore.delete(sessionId);
    }
  }

  // Load from database
  const dbSession = await getSessionBySessionId(sessionId);
  if (!dbSession) {
    return null;
  }

  // Load messages for context
  const messages = await getMessagesBySessionId(sessionId);

  // Build session state object with enhanced conversation tracking
  const sessionState = {
    sessionId: dbSession.session_id,
    userContext: {
      fullName: dbSession.user_name || null,
      email: dbSession.email || null,
      phone: dbSession.phone || null,
      company: dbSession.company || null,
      vsaAgent: dbSession.vsa_agent_name || null
    },
    intake: {
      issue: dbSession.issue || null,
      category: dbSession.category || null,
      urgency: dbSession.urgency || null,
      affectedSystem: dbSession.affected_system || null,
      errorText: dbSession.error_text !== undefined ? dbSession.error_text : null
    },
    askedQuestions: dbSession.asked_questions 
      ? (typeof dbSession.asked_questions === 'string' 
          ? JSON.parse(dbSession.asked_questions) 
          : dbSession.asked_questions)
      : [],
    isSubmitted: dbSession.submitted === true || dbSession.intake_status === 'complete',
    createdAt: dbSession.created_at,
    messages: messages.map(msg => ({
      sender: msg.sender,
      message: msg.message_text,
      timestamp: msg.created_at
    })),
    // Enhanced conversation tracking
    lastIntent: null,
    lastBotQuestion: null,        // Last question asked by bot (memory only)
    lastExpectedField: null,      // Field the bot was asking about (memory only)
    answeredFields: [],           // Fields that have been answered (memory only)
    confidenceByField: dbSession.confidence_by_field 
      ? (typeof dbSession.confidence_by_field === 'string' 
          ? JSON.parse(dbSession.confidence_by_field) 
          : dbSession.confidence_by_field)
      : {},        // Confidence scores: { field: 0.0-1.0 } - NOW PERSISTED
    conversationMode: CONVERSATION_MODE.INTAKE, // Legacy mode (for backward compatibility)
    conversationState: dbSession.conversation_state || 'INIT',    // NOW PERSISTED - do NOT default to INIT if present
    submissionDeclined: dbSession.submission_declined || false,    // NOW PERSISTED
    submissionApproved: dbSession.submission_approved || false,    // NOW PERSISTED
    expiresAt: Date.now() + SESSION_TIMEOUT_MS
  };

  // Store in memory
  sessionStore.set(sessionId, sessionState);

  return sessionState;
};

/**
 * Update session state (merge new data)
 */
export const updateSessionState = async (sessionId, updates) => {
  let sessionState = await loadSessionState(sessionId);
  
  if (!sessionState) {
    throw new Error('Session not found');
  }

  // Merge updates
  if (updates.userContext) {
    sessionState.userContext = {
      ...sessionState.userContext,
      ...updates.userContext
    };
  }

  if (updates.intake) {
    // Only merge non-null values (don't overwrite existing valid data)
    sessionState.intake = {
      ...sessionState.intake,
      ...Object.fromEntries(
        Object.entries(updates.intake).filter(([_, value]) => value !== null)
      )
    };
  }

  if (updates.isSubmitted !== undefined) {
    sessionState.isSubmitted = updates.isSubmitted;
  }

  if (updates.askedQuestions) {
    if (!sessionState.askedQuestions) {
      sessionState.askedQuestions = [];
    }
    // Add new questions, avoiding duplicates
    updates.askedQuestions.forEach(q => {
      if (!sessionState.askedQuestions.includes(q)) {
        sessionState.askedQuestions.push(q);
      }
    });
  }

  if (updates.message) {
    if (!sessionState.messages) {
      sessionState.messages = [];
    }
    sessionState.messages.push(updates.message);
  }

  if (updates.lastIntent !== undefined) {
    sessionState.lastIntent = updates.lastIntent;
  }

  // Enhanced conversation tracking updates
  if (updates.lastBotQuestion !== undefined) {
    sessionState.lastBotQuestion = updates.lastBotQuestion;
  }
  if (updates.lastExpectedField !== undefined) {
    sessionState.lastExpectedField = updates.lastExpectedField;
  }
  if (updates.answeredFields !== undefined) {
    // Merge answered fields, avoiding duplicates
    if (!sessionState.answeredFields) {
      sessionState.answeredFields = [];
    }
    updates.answeredFields.forEach(field => {
      if (!sessionState.answeredFields.includes(field)) {
        sessionState.answeredFields.push(field);
      }
    });
  }
  if (updates.confidenceByField !== undefined) {
    sessionState.confidenceByField = {
      ...sessionState.confidenceByField,
      ...updates.confidenceByField
    };
  }
  if (updates.conversationMode !== undefined) {
    sessionState.conversationMode = updates.conversationMode;
  }
  if (updates.conversationState !== undefined) {
    sessionState.conversationState = updates.conversationState;
  }
  if (updates.submissionDeclined !== undefined) {
    sessionState.submissionDeclined = updates.submissionDeclined;
  }
  if (updates.submissionApproved !== undefined) {
    sessionState.submissionApproved = updates.submissionApproved;
  }

  // Update expiration
  sessionState.expiresAt = Date.now() + SESSION_TIMEOUT_MS;

  // Persist to database
  const dbUpdates = {};
  if (updates.intake) {
    if (updates.intake.issue !== undefined) dbUpdates.issue = updates.intake.issue;
    if (updates.intake.category !== undefined) dbUpdates.category = updates.intake.category;
    if (updates.intake.urgency !== undefined) dbUpdates.urgency = updates.intake.urgency;
    if (updates.intake.affectedSystem !== undefined) dbUpdates.affected_system = updates.intake.affectedSystem;
    if (updates.intake.errorText !== undefined) dbUpdates.error_text = updates.intake.errorText;
  }
  if (updates.isSubmitted !== undefined) {
    dbUpdates.submitted = updates.isSubmitted;
    dbUpdates.intake_status = updates.isSubmitted ? 'complete' : 'in_progress';
  }

  if (updates.askedQuestions) {
    dbUpdates.asked_questions = JSON.stringify(sessionState.askedQuestions);
  }

  // Persist critical state variables
  if (updates.conversationState !== undefined) {
    dbUpdates.conversation_state = updates.conversationState;
  }
  if (updates.submissionApproved !== undefined) {
    dbUpdates.submission_approved = updates.submissionApproved;
  }
  if (updates.submissionDeclined !== undefined) {
    dbUpdates.submission_declined = updates.submissionDeclined;
  }
  if (updates.confidenceByField !== undefined) {
    dbUpdates.confidence_by_field = JSON.stringify(sessionState.confidenceByField);
  }

  if (Object.keys(dbUpdates).length > 0) {
    await updateSession(sessionId, dbUpdates);
  }

  // Update memory
  sessionStore.set(sessionId, sessionState);

  return sessionState;
};

/**
 * Compute missing fields from intake state
 */
export const getMissingFields = (sessionState) => {
  const intake = sessionState.intake || {};
  const missing = [];
  
  if (!intake.issue) missing.push('issue');
  if (!intake.category) missing.push('category');
  if (!intake.urgency) missing.push('urgency');
  if (!intake.affectedSystem) missing.push('affectedSystem');
  if (intake.errorText === null || intake.errorText === undefined) missing.push('errorText');
  
  return missing;
};

/**
 * Check if session has all required fields for submission
 */
export const canSubmitTicket = (sessionState) => {
  const missingFields = getMissingFields(sessionState);
  return missingFields.length === 0;
};

/**
 * Check category-aware stop conditions
 * Some categories don't need all fields
 */
export const canSubmitTicketCategoryAware = (sessionState) => {
  const intake = sessionState.intake || {};
  const category = intake.category;
  
  // Password reset: issue, errorText, urgency are enough
  if (category === 'password') {
    return !!(intake.issue && intake.errorText !== null && intake.errorText !== undefined && intake.urgency);
  }
  
  // For other categories, require all fields
  return canSubmitTicket(sessionState);
};

/**
 * Create initial session state
 */
export const createSessionState = async (sessionId, userContext) => {
  const sessionState = {
    sessionId,
    userContext: {
      fullName: userContext.fullName || null,
      email: userContext.email || null,
      phone: userContext.phone || null,
      company: userContext.company || null,
      vsaAgent: userContext.vsaAgent || null
    },
    intake: {
      issue: null,
      category: null,
      urgency: null,
      affectedSystem: null,
      errorText: null
    },
    askedQuestions: [],
    isSubmitted: false,
    createdAt: new Date(),
    messages: [],
    // Enhanced conversation tracking initialized
    lastIntent: null,
    lastBotQuestion: null,
    lastExpectedField: null,
    answeredFields: [],
    confidenceByField: {},
    conversationMode: CONVERSATION_MODE.INTAKE,
    conversationState: 'INIT',
    submissionDeclined: false,
    submissionApproved: false,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS
  };

  sessionStore.set(sessionId, sessionState);
  return sessionState;
};

/**
 * Mark session as submitted
 */
export const markSessionSubmitted = async (sessionId) => {
  return await updateSessionState(sessionId, { isSubmitted: true });
};

export default {
  loadSessionState,
  updateSessionState,
  canSubmitTicket,
  canSubmitTicketCategoryAware,
  getMissingFields,
  createSessionState,
  markSessionSubmitted,
  CONVERSATION_MODE
};

