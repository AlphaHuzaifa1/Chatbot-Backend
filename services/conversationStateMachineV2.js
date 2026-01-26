/**
 * CONVERSATION STATE MACHINE V2
 * 
 * Production-grade state machine with backend enforcement.
 * The backend OWNS state transitions - LLM only suggests.
 * 
 * States:
 * - INIT: Initial state, waiting for first user message
 * - PROBING: Actively asking questions to collect information
 * - CLARIFYING: Bot clarifying or user asking for clarification
 * - WAITING: Explicit pause state - user said "wait", "hold on", etc.
 * - READY_TO_SUBMIT: All required fields collected, showing summary
 * - CONFIRMING_SUBMISSION: User is confirming submission (yes/no)
 * - SUBMITTED: Ticket submitted, conversation ended
 * - FAILED_SAFE_MODE: LLM failed, using fallback collection
 */

export const CONVERSATION_STATE = {
  INIT: 'INIT',
  PROBING: 'PROBING',
  CLARIFYING: 'CLARIFYING',
  WAITING: 'WAITING',
  READY_TO_SUBMIT: 'READY_TO_SUBMIT',
  CONFIRMING_SUBMISSION: 'CONFIRMING_SUBMISSION',
  SUBMITTED: 'SUBMITTED',
  FAILED_SAFE_MODE: 'FAILED_SAFE_MODE'
};

/**
 * State transition rules
 * Format: currentState -> intent -> nextState
 * Backend enforces these - LLM cannot override
 */
const STATE_TRANSITIONS = {
  [CONVERSATION_STATE.INIT]: {
    'provide_info': CONVERSATION_STATE.PROBING,
    'ask_question': CONVERSATION_STATE.CLARIFYING,
    'idle': CONVERSATION_STATE.INIT,
    'off_topic': CONVERSATION_STATE.INIT, // Stay in INIT, redirect
    'security_risk': CONVERSATION_STATE.CLARIFYING, // Block and clarify
  },
  [CONVERSATION_STATE.PROBING]: {
    'provide_info': CONVERSATION_STATE.PROBING,
    'add_more_info': CONVERSATION_STATE.PROBING,
    'ask_question': CONVERSATION_STATE.CLARIFYING,
    'interrupt_wait': CONVERSATION_STATE.WAITING,
    'no_more_info': CONVERSATION_STATE.READY_TO_SUBMIT, // If fields complete
    'frustration': CONVERSATION_STATE.PROBING, // Stay in probing, be patient
    'off_topic': CONVERSATION_STATE.PROBING, // Stay in probing, redirect
    'security_risk': CONVERSATION_STATE.CLARIFYING,
    'idle': CONVERSATION_STATE.PROBING
  },
  [CONVERSATION_STATE.CLARIFYING]: {
    'provide_info': CONVERSATION_STATE.PROBING,
    'ask_question': CONVERSATION_STATE.CLARIFYING,
    'interrupt_wait': CONVERSATION_STATE.WAITING,
    'security_risk': CONVERSATION_STATE.CLARIFYING,
    'idle': CONVERSATION_STATE.CLARIFYING
  },
  [CONVERSATION_STATE.WAITING]: {
    'add_more_info': CONVERSATION_STATE.PROBING,
    'provide_info': CONVERSATION_STATE.PROBING, // User resumed
    'confirm_submit': CONVERSATION_STATE.READY_TO_SUBMIT, // If ready
    'interrupt_wait': CONVERSATION_STATE.WAITING, // Still waiting
    'security_risk': CONVERSATION_STATE.CLARIFYING
  },
  [CONVERSATION_STATE.READY_TO_SUBMIT]: {
    'confirm_submit': CONVERSATION_STATE.CONFIRMING_SUBMISSION,
    'deny_submit': CONVERSATION_STATE.PROBING,
    'add_more_info': CONVERSATION_STATE.PROBING,
    'ask_question': CONVERSATION_STATE.CLARIFYING,
    'security_risk': CONVERSATION_STATE.CLARIFYING
  },
  [CONVERSATION_STATE.CONFIRMING_SUBMISSION]: {
    // Terminal - only submission happens here
  },
  [CONVERSATION_STATE.SUBMITTED]: {
    // Terminal state - no transitions
  },
  [CONVERSATION_STATE.FAILED_SAFE_MODE]: {
    'provide_info': CONVERSATION_STATE.FAILED_SAFE_MODE,
    'no_more_info': CONVERSATION_STATE.READY_TO_SUBMIT
  }
};

/**
 * State behavior definitions
 * What actions are allowed/forbidden in each state
 */
export const STATE_BEHAVIOR = {
  [CONVERSATION_STATE.INIT]: {
    allowedActions: ['greet', 'acknowledge', 'ask_question'],
    forbiddenActions: ['submit', 'extract_fields', 'confirm_submission'],
    description: 'Initial state - waiting for user to describe their issue'
  },
  [CONVERSATION_STATE.PROBING]: {
    allowedActions: ['acknowledge', 'extract_fields', 'ask_question', 'clarify'],
    forbiddenActions: ['submit', 'auto_submit'],
    description: 'Actively collecting information - asking questions about missing fields'
  },
  [CONVERSATION_STATE.CLARIFYING]: {
    allowedActions: ['rephrase', 'explain', 'acknowledge'],
    forbiddenActions: ['submit', 'ask_new_question', 'extract_fields'],
    description: 'Clarifying previous question or user asking for clarification'
  },
  [CONVERSATION_STATE.WAITING]: {
    allowedActions: ['acknowledge_wait', 'offer_resume'],
    forbiddenActions: ['ask_questions', 'submit', 'extract_fields'],
    description: 'User explicitly paused - waiting for user to resume'
  },
  [CONVERSATION_STATE.READY_TO_SUBMIT]: {
    allowedActions: ['show_summary', 'ask_confirmation'],
    forbiddenActions: ['submit_without_confirmation', 'ask_questions', 'extract_fields'],
    description: 'All required fields collected - showing summary and asking for confirmation'
  },
  [CONVERSATION_STATE.CONFIRMING_SUBMISSION]: {
    allowedActions: ['submit_ticket'],
    forbiddenActions: ['ask_questions', 'modify_intake'],
    description: 'User confirmed - submitting ticket'
  },
  [CONVERSATION_STATE.SUBMITTED]: {
    allowedActions: ['confirm_submission', 'end_conversation'],
    forbiddenActions: ['ask_questions', 'modify_intake', 'submit'],
    description: 'Ticket submitted - conversation ended'
  },
  [CONVERSATION_STATE.FAILED_SAFE_MODE]: {
    allowedActions: ['collect_raw_text', 'submit_basic_ticket'],
    forbiddenActions: ['use_llm', 'extract_structured_fields'],
    description: 'LLM failed - using fallback mode to collect raw issue description'
  }
};

/**
 * Check if a transition is allowed
 * Backend enforcement - LLM cannot override
 */
export const canTransition = (currentState, intent) => {
  const transitions = STATE_TRANSITIONS[currentState];
  if (!transitions) return false;
  return intent in transitions;
};

/**
 * Get next state for a transition
 * Returns current state if transition not allowed
 */
export const getNextState = (currentState, intent) => {
  const transitions = STATE_TRANSITIONS[currentState];
  if (!transitions || !(intent in transitions)) {
    return currentState; // No transition allowed, stay in current state
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

/**
 * Validate state transition with context
 * Checks if transition makes sense given current state and context
 */
export const validateTransition = (currentState, intent, context = {}) => {
  // Check if transition is allowed
  if (!canTransition(currentState, intent)) {
    return {
      valid: false,
      reason: `Transition from ${currentState} with intent ${intent} is not allowed`
    };
  }

  // Context-specific validations
  if (intent === 'no_more_info' && currentState === CONVERSATION_STATE.PROBING) {
    // Only allow if we have minimum required fields
    const hasMinimumFields = context.hasMinimumFields || false;
    if (!hasMinimumFields) {
      return {
        valid: false,
        reason: 'Cannot transition to READY_TO_SUBMIT without minimum required fields'
      };
    }
  }

  if (intent === 'confirm_submit' && currentState === CONVERSATION_STATE.READY_TO_SUBMIT) {
    // Only allow if all fields are complete
    const allFieldsComplete = context.allFieldsComplete || false;
    if (!allFieldsComplete) {
      return {
        valid: false,
        reason: 'Cannot submit without all required fields'
      };
    }
  }

  return { valid: true };
};

export default {
  CONVERSATION_STATE,
  STATE_BEHAVIOR,
  canTransition,
  getNextState,
  getAllowedIntents,
  isActionAllowed,
  isActionForbidden,
  validateTransition
};

