/**
 * CONVERSATION STATE MACHINE
 * 
 * Strict state machine for production-grade chatbot flow.
 * Each state defines allowed intents, transitions, and bot behavior.
 */

export const CONVERSATION_STATE = {
  INIT: 'INIT',                    // Initial state, waiting for first user message
  INTAKE: 'INTAKE',                // Collecting information from user
  CLARIFYING: 'CLARIFYING',        // Bot clarifying or user asking for clarification
  READY_TO_SUBMIT: 'READY_TO_SUBMIT', // All fields collected, waiting for user confirmation
  WAITING: 'WAITING',              // User paused, waiting for resume
  SUBMITTED: 'SUBMITTED',          // Ticket submitted, conversation ended
  BLOCKED_SECURITY: 'BLOCKED_SECURITY' // Security violation, blocked until acknowledgment
};

/**
 * State transition table
 * Maps: currentState -> allowedIntents -> nextState
 */
const STATE_TRANSITIONS = {
  [CONVERSATION_STATE.INIT]: {
    'provide_info': CONVERSATION_STATE.INTAKE,
    'clarify': CONVERSATION_STATE.CLARIFYING,
    'greeting': CONVERSATION_STATE.INIT,
    'frustration': CONVERSATION_STATE.INTAKE,
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY,
    'idle': CONVERSATION_STATE.INIT
  },
  [CONVERSATION_STATE.INTAKE]: {
    'provide_info': CONVERSATION_STATE.INTAKE,
    'clarify': CONVERSATION_STATE.CLARIFYING,
    'interrupt_wait': CONVERSATION_STATE.WAITING,
    'frustration': CONVERSATION_STATE.INTAKE,
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY,
    'idle': CONVERSATION_STATE.INTAKE,
    'add_more_info': CONVERSATION_STATE.INTAKE
  },
  [CONVERSATION_STATE.CLARIFYING]: {
    'provide_info': CONVERSATION_STATE.INTAKE,
    'clarify': CONVERSATION_STATE.CLARIFYING,
    'frustration': CONVERSATION_STATE.INTAKE,
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY,
    'idle': CONVERSATION_STATE.INTAKE
  },
  [CONVERSATION_STATE.READY_TO_SUBMIT]: {
    'confirm_submit': CONVERSATION_STATE.SUBMITTED,
    'deny_submit': CONVERSATION_STATE.INTAKE,
    'add_more_info': CONVERSATION_STATE.INTAKE, // Explicit only
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY
    // Note: provide_info, clarify, and other intents are NOT allowed - will stay in READY_TO_SUBMIT
  },
  [CONVERSATION_STATE.WAITING]: {
    'add_more_info': CONVERSATION_STATE.INTAKE, // Explicit resume
    'interrupt_wait': CONVERSATION_STATE.WAITING, // Stay in WAITING (user still waiting)
    'provide_info': CONVERSATION_STATE.WAITING, // Stay in WAITING (ignore info until explicit resume)
    'confirm_submit': CONVERSATION_STATE.READY_TO_SUBMIT, // If ready
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY
  },
  [CONVERSATION_STATE.BLOCKED_SECURITY]: {
    'acknowledge_security': CONVERSATION_STATE.INTAKE, // Resume after acknowledgment
    'security_risk': CONVERSATION_STATE.BLOCKED_SECURITY
  },
  [CONVERSATION_STATE.SUBMITTED]: {
    // Terminal state - no transitions allowed
  }
};

/**
 * State behavior definitions
 * What the bot is allowed/forbidden to do in each state
 */
export const STATE_BEHAVIOR = {
  [CONVERSATION_STATE.INIT]: {
    allowedActions: ['greet', 'ask_question', 'acknowledge'],
    forbiddenActions: ['submit', 'confirm_submission'],
    canAskAbout: ['issue', 'category', 'urgency', 'affectedSystem', 'errorText'],
    mustAskAbout: null // No requirement
  },
  [CONVERSATION_STATE.INTAKE]: {
    allowedActions: ['ask_question', 'acknowledge', 'extract_fields', 'clarify'],
    forbiddenActions: ['submit', 'auto_submit'],
    canAskAbout: ['issue', 'category', 'urgency', 'affectedSystem', 'errorText'],
    mustAskAbout: null // Based on missing fields
  },
  [CONVERSATION_STATE.CLARIFYING]: {
    allowedActions: ['rephrase', 'explain', 'acknowledge'],
    forbiddenActions: ['submit', 'ask_new_question'],
    canAskAbout: null,
    mustAskAbout: null
  },
  [CONVERSATION_STATE.READY_TO_SUBMIT]: {
    allowedActions: ['show_summary', 'ask_confirmation'],
    forbiddenActions: ['submit_without_confirmation', 'ask_questions'],
    canAskAbout: null,
    mustAskAbout: null
  },
  [CONVERSATION_STATE.WAITING]: {
    allowedActions: ['acknowledge_wait', 'offer_resume'],
    forbiddenActions: ['ask_questions', 'submit'],
    canAskAbout: null,
    mustAskAbout: null
  },
  [CONVERSATION_STATE.BLOCKED_SECURITY]: {
    allowedActions: ['warn', 'request_acknowledgment'],
    forbiddenActions: ['continue_conversation', 'store_message', 'submit'],
    canAskAbout: null,
    mustAskAbout: null
  },
  [CONVERSATION_STATE.SUBMITTED]: {
    allowedActions: ['confirm_submission', 'end_conversation'],
    forbiddenActions: ['ask_questions', 'modify_intake'],
    canAskAbout: null,
    mustAskAbout: null
  }
};

/**
 * Check if a transition is allowed
 */
export const canTransition = (currentState, intent) => {
  const transitions = STATE_TRANSITIONS[currentState];
  if (!transitions) return false;
  return intent in transitions;
};

/**
 * Get next state for a transition
 */
export const getNextState = (currentState, intent) => {
  const transitions = STATE_TRANSITIONS[currentState];
  if (!transitions || !(intent in transitions)) {
    return currentState; // No transition, stay in current state
  }
  return transitions[intent];
};

/**
 * Get allowed intents for current state
 */
export const getAllowedIntents = (currentState) => {
  const transitions = STATE_TRANSITIONS[currentState];
  return transitions ? Object.keys(transitions) : [];
};

/**
 * Check if an action is allowed in current state
 */
export const isActionAllowed = (state, action) => {
  const behavior = STATE_BEHAVIOR[state];
  if (!behavior) return false;
  return behavior.allowedActions.includes(action);
};

/**
 * Check if an action is forbidden in current state
 */
export const isActionForbidden = (state, action) => {
  const behavior = STATE_BEHAVIOR[state];
  if (!behavior) return true; // Default to forbidden if state unknown
  return behavior.forbiddenActions.includes(action);
};

export default {
  CONVERSATION_STATE,
  STATE_BEHAVIOR,
  canTransition,
  getNextState,
  getAllowedIntents,
  isActionAllowed,
  isActionForbidden
};

