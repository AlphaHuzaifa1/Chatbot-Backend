/**
 * UNIFIED LLM SERVICE
 * 
 * Single OpenAI call per user message.
 * Handles intent detection, field extraction, flow decision, and response generation.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { CONVERSATION_STATE } from './conversationStateMachine.js';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
} else {
  console.warn('OPENAI_API_KEY not configured. AI features will be disabled.');
}

/**
 * Build full conversation history for LLM
 * Includes all messages with role-based formatting
 */
const buildMessageHistory = (messages = [], maxTurns = 20) => {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Get last N turns (user + system pairs)
  const recentMessages = messages.slice(-maxTurns * 2);
  const history = [];

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const role = msg.sender === 'user' ? 'user' : 'assistant';
    history.push({
      role,
      content: msg.message
    });
  }

  return history;
};

/**
 * Build comprehensive system prompt
 */
const buildSystemPrompt = (sessionState, stateMachine) => {
  const { conversationState, intakeFields, confidenceByField, userContext } = sessionState;
  const { STATE_BEHAVIOR } = stateMachine;

  // Build current intake status
  const collectedFields = [];
  const missingFields = [];
  
  Object.entries(intakeFields).forEach(([field, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      collectedFields.push({
        field,
        value,
        confidence: confidenceByField[field] || 0.5
      });
    } else {
      missingFields.push(field);
    }
  });

  const collectedSummary = collectedFields.length > 0
    ? collectedFields.map(f => `- ${f.field}: "${f.value}" (confidence: ${f.confidence.toFixed(2)})`).join('\n')
    : 'None collected yet.';

  const missingSummary = missingFields.length > 0
    ? missingFields.map(f => `- ${f}`).join('\n')
    : 'All required fields collected.';

  // Get state behavior
  const behavior = STATE_BEHAVIOR[conversationState] || {};

  // Build category-specific rules
  const category = intakeFields.category;
  const categoryRules = category === 'password'
    ? 'For password reset: issue, urgency, and errorText are required. affectedSystem is optional.'
    : 'For all other categories: issue, category, urgency, affectedSystem, and errorText are all required.';

  return `You are a professional IT support chatbot assistant. Your role is to collect information from users to create support tickets.

CURRENT CONVERSATION STATE: ${conversationState}

STATE RULES:
${JSON.stringify(behavior, null, 2)}

INTAKE STATUS:
Fields collected:
${collectedSummary}

Fields still missing:
${missingSummary}

CATEGORY RULES:
${categoryRules}

FIELD DEFINITIONS:
- problem: Description of the technical issue the user is experiencing
- category: One of: "password", "hardware", "software", "network", "email", "other"
- urgency: One of: "blocked" (work completely blocked), "high" (urgent but workaround exists), "medium" (moderate impact), "low" (minor inconvenience)
- affectedSystem: The specific application, system, or service affected (e.g., "Outlook", "Windows", "Network")
- errorText: Any error messages shown to the user, or "no error provided" if none

CONVERSATION RULES:
1. You must understand the FULL MEANING of user messages, not just keywords
2. Extract MULTIPLE fields from a single message when possible
3. NEVER ask about information already collected (check collected fields above)
4. NEVER repeat questions you've already asked
5. Be conversational, empathetic, and professional
6. Generate natural, context-aware responses (no templates)
7. If user says "wait", "let me add more", "nothing more", or "submit now", respect their intent
8. NEVER submit a ticket without explicit user confirmation
9. If user declines submission, return to INTAKE state and ask what they'd like to update

SECURITY RULES:
- If user intends to share passwords, PINs, codes, tokens, or MFA codes, detect this as security_risk intent
- Immediately block and warn - do not store the message
- Wait for acknowledgment before resuming

INTENT DETECTION:
You must infer intent from FULL SENTENCE MEANING and conversation context:
- provide_info: User providing information to answer a question OR describing their issue (this is the most common intent when user describes a problem)
- clarify: User asking bot to clarify or repeat something
- interrupt_wait: User saying "wait", "hold on", "let me think", "give me a moment"
- confirm_submit: User explicitly confirming submission (yes, go ahead, submit)
- deny_submit: User declining submission (no, not yet, wait)
- add_more_info: User saying "let me add more", "I want to add", "one more thing"
- frustration: User frustrated, repeating themselves, saying "I don't know"
- security_risk: User intends to share sensitive data
- idle: User message is unclear, empty, or completely off-topic (NOT for greetings or issue descriptions)
- no_more_info: User saying "that's all", "nothing more", "that's everything"

IMPORTANT: 
- Greetings like "Hi", "Hello" should be treated as provide_info if followed by issue description, or handled gracefully
- If user describes ANY technical issue, use provide_info intent (NOT idle)
- Only use idle for truly unclear or empty messages

FLOW DECISIONS:
- ASK: Ask a question about a missing field (use this when you need more information)
- WAIT: Acknowledge and wait (ONLY if user explicitly said "wait", "hold on", etc. - NOT for regular messages)
- READY: All fields collected with sufficient confidence - show summary and ask for confirmation
- SUBMIT: User explicitly confirmed - proceed to submission (backend will handle actual submission)
- BLOCK: Security risk detected - block and warn

IMPORTANT:
- In INIT or INTAKE state, if user provides ANY information about their issue, use ASK flow_decision (to ask for more details)
- Only use WAIT if user explicitly pauses the conversation
- NEVER use WAIT for normal information-providing messages

You must respond with STRICT JSON in this exact format:
{
  "intent": "provide_info|clarify|interrupt_wait|confirm_submit|deny_submit|add_more_info|frustration|security_risk|idle|no_more_info",
  "intent_confidence": 0.0-1.0,
  "field_updates": {
    "problem": { "value": "string or null", "confidence": 0.0-1.0 },
    "category": { "value": "string or null", "confidence": 0.0-1.0 },
    "urgency": { "value": "string or null", "confidence": 0.0-1.0 },
    "affectedSystem": { "value": "string or null", "confidence": 0.0-1.0 },
    "errorText": { "value": "string or null", "confidence": 0.0-1.0 }
  },
  "flow_decision": "ASK|WAIT|READY|SUBMIT|BLOCK",
  "response": "Natural human message to show user (no templates, be conversational)",
  "needs_confirmation": true|false
}

CRITICAL RULES:
- Only update fields that are MISSING (null in current intake)
- Set confidence based on how clear the information is (0.0-1.0)
- flow_decision must match the conversation state and intent
- response must be natural, empathetic, and context-aware
- needs_confirmation must be true if flow_decision is READY or SUBMIT`;
};

/**
 * Process user message with single LLM call
 * Returns: intent, field updates, flow decision, and response
 */
export const processUserMessageUnified = async (sessionState, messageHistory, currentUserMessage = null) => {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  if (!sessionState || !messageHistory) {
    throw new Error('Invalid session state or message history');
  }

  const stateMachine = await import('./conversationStateMachine.js');
  const systemPrompt = buildSystemPrompt(sessionState, stateMachine);
  
  // Build message history (excluding the current user message if it's already in history)
  const history = buildMessageHistory(messageHistory);
  
  // Get the current user message - prefer explicit parameter, then from history
  let userMessage = currentUserMessage;
  if (!userMessage && history.length > 0) {
    // Find the last user message in history
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        userMessage = history[i].content;
        // Remove it from history since we'll add it back explicitly
        history.splice(i, 1);
        break;
      }
    }
  }
  
  if (!userMessage || userMessage.trim().length === 0) {
    throw new Error('User message is required and cannot be empty');
  }

  // Build messages array: system prompt + history + current user message
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history, // All previous messages
    { role: 'user', content: userMessage }
  ];

  const startTime = Date.now();

  try {
    if (ENABLE_LOGGING) {
      console.log('[Unified LLM] Processing message:', {
        sessionId: sessionState.sessionId,
        conversationState: sessionState.conversationState,
        messageLength: userMessage.length,
        userMessage: userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : ''),
        historyTurns: Math.floor(history.length / 2),
        totalMessages: messages.length
      });
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7, // Higher for natural variation
      max_tokens: 800, // More tokens for comprehensive response
      response_format: { type: 'json_object' }
    });

    const latency = Date.now() - startTime;
    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(content);
    } catch (parseError) {
      if (ENABLE_LOGGING) {
        console.error('[Unified LLM] JSON parse error:', parseError.message);
        console.error('[Unified LLM] Raw response:', content);
      }
      throw new Error(`Invalid JSON response: ${parseError.message}`);
    }

    // Validate response structure
    const validation = validateLLMResponse(parsedResponse);
    if (!validation.valid) {
      if (ENABLE_LOGGING) {
        console.error('[Unified LLM] Validation error:', validation.error);
      }
      throw new Error(`Invalid response structure: ${validation.error}`);
    }

    if (ENABLE_LOGGING) {
      console.log('[Unified LLM] Success:', {
        intent: parsedResponse.intent,
        intentConfidence: parsedResponse.intent_confidence,
        flowDecision: parsedResponse.flow_decision,
        fieldsUpdated: Object.values(parsedResponse.field_updates).filter(f => f.value !== null).length,
        latency: `${latency}ms`
      });
    }

    return {
      ...parsedResponse,
      _metadata: {
        latency,
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Unified LLM] Error:', error.message);
    }
    throw error;
  }
};

/**
 * Validate LLM response structure
 */
const validateLLMResponse = (response) => {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }

  // Required fields
  const required = ['intent', 'intent_confidence', 'field_updates', 'flow_decision', 'response', 'needs_confirmation'];
  for (const field of required) {
    if (!(field in response)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate intent
  const validIntents = [
    'provide_info', 'clarify', 'interrupt_wait', 'confirm_submit', 'deny_submit',
    'add_more_info', 'frustration', 'security_risk', 'idle', 'no_more_info'
  ];
  if (!validIntents.includes(response.intent)) {
    return { valid: false, error: `Invalid intent: ${response.intent}` };
  }

  // Validate intent_confidence
  if (typeof response.intent_confidence !== 'number' || 
      response.intent_confidence < 0 || 
      response.intent_confidence > 1) {
    return { valid: false, error: 'intent_confidence must be a number between 0 and 1' };
  }

  // Validate field_updates
  if (typeof response.field_updates !== 'object' || response.field_updates === null) {
    return { valid: false, error: 'field_updates must be an object' };
  }

  // Validate each field that is present (allow missing fields - they'll be treated as null)
  const allowedFields = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];
  for (const [field, fieldUpdate] of Object.entries(response.field_updates)) {
    // Check if field is allowed
    if (!allowedFields.includes(field)) {
      return { valid: false, error: `Unknown field in field_updates: ${field}` };
    }
    
    // Allow null for field updates, but if it's an object, it must have value and confidence
    if (fieldUpdate !== null && typeof fieldUpdate !== 'object') {
      return { valid: false, error: `Invalid field_update type for ${field}: must be object or null` };
    }
    
    if (fieldUpdate !== null) {
      if (!('value' in fieldUpdate) || !('confidence' in fieldUpdate)) {
        return { valid: false, error: `Invalid field_update structure for ${field}: must have value and confidence` };
      }
      if (typeof fieldUpdate.confidence !== 'number' || 
          fieldUpdate.confidence < 0 || 
          fieldUpdate.confidence > 1) {
        return { valid: false, error: `Invalid confidence for ${field}: must be number between 0 and 1` };
      }
    }
  }
  
  // Ensure all required fields exist (add missing ones as null)
  // This is done after validation to normalize the response
  const requiredFields = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];
  for (const field of requiredFields) {
    if (!(field in response.field_updates)) {
      response.field_updates[field] = { value: null, confidence: 0 };
    }
  }

  // Validate flow_decision
  const validDecisions = ['ASK', 'WAIT', 'READY', 'SUBMIT', 'BLOCK'];
  if (!validDecisions.includes(response.flow_decision)) {
    return { valid: false, error: `Invalid flow_decision: ${response.flow_decision}` };
  }

  // Validate response
  if (typeof response.response !== 'string' || response.response.trim().length === 0) {
    return { valid: false, error: 'response must be a non-empty string' };
  }

  // Validate needs_confirmation
  if (typeof response.needs_confirmation !== 'boolean') {
    return { valid: false, error: 'needs_confirmation must be a boolean' };
  }

  return { valid: true };
};

/**
 * Check if OpenAI is available
 */
export const isOpenAIAvailable = () => {
  return openai !== null;
};

export default {
  processUserMessageUnified,
  isOpenAIAvailable
};

