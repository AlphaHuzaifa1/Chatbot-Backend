import { getSessionBySessionId, updateSession } from '../models/sessionModel.js';
import { getMessagesBySessionId } from '../models/messageModel.js';

/**
 * Session State Service
 * Manages in-memory session state following the ChatSession model
 * Falls back to database for persistence
 */

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

  // Build session state object
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
    lastIntent: null, // Stored in memory only, not persisted to DB
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
    lastIntent: null,
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
  markSessionSubmitted
};

