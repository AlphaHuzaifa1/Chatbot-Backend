import OpenAI from 'openai';
import dotenv from 'dotenv';
import { isOpenAIAvailable } from './openaiService.js';

dotenv.config();

const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Supported intents - Enhanced with production-grade intent understanding
 */
export const INTENT = {
  // Existing intents
  GREETING: 'GREETING',
  ANSWER: 'ANSWER',
  CLARIFICATION: 'CLARIFICATION',
  UNKNOWN: 'UNKNOWN',
  SUBMIT_REQUEST: 'SUBMIT_REQUEST',
  FRUSTRATION: 'FRUSTRATION',
  
  // New intents for better conversation understanding
  PROVIDE_INFO: 'PROVIDE_INFO',        // User providing information (more specific than ANSWER)
  CORRECT_PREVIOUS: 'CORRECT_PREVIOUS', // User correcting a previous answer
  OFF_TOPIC: 'OFF_TOPIC',              // User message is off-topic (math, jokes, etc.)
  SECURITY_RISK: 'SECURITY_RISK',      // User intends to share sensitive data
  CONFUSED: 'CONFUSED',                // User is confused or doesn't understand
  CONFIRMATION: 'CONFIRMATION',        // User confirming (yes/no to submission)
  CANCEL: 'CANCEL'                    // User wants to cancel/abandon ticket
};

/**
 * Rule-based intent detection (fast, deterministic)
 * Enhanced with new intent patterns for production-grade understanding
 */
const detectIntentRules = (userMessage, conversationContext = [], lastExpectedField = null) => {
  const normalized = userMessage.toLowerCase().trim();
  
  // Cancel/abandon intent (check first, high priority)
  const cancelPatterns = [
    /(cancel|abandon|never mind|forget it|don't worry|not needed)/i,
    /(i changed my mind|i don't need|not anymore)/
  ];
  if (cancelPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CANCEL;
  }
  
  // Security risk detection - intent to share sensitive data (not just literal patterns)
  // Enhanced patterns to catch more variations - now catches intent even without actual data
  const securityRiskPatterns = [
    /(i will share|i'll share|can i send|here is my|let me give you|i want to share|let me share)/i,
    /(my password is|my pin is|my code is|my token is|my otp is|my account password)/i,
    /(should i send|can i provide|do you need my|can i share|want to share)/i,
    /(password|pin|code|token|otp|mfa|credentials|account).*(share|send|give|provide|tell|with you)/i,
    /(share|send|give|provide).*(password|pin|code|token|otp|mfa|credentials|account)/i,
    /(here are my|here's my|let me send you|i can give you).*(password|pin|code|token|otp|mfa|credentials)/i
  ];
  if (securityRiskPatterns.some(pattern => pattern.test(normalized))) {
    // Check if it contains actual sensitive data pattern OR just intent to share
    const hasActualData = /(password|pin|code|token|otp|mfa)\s*[:=]\s*\S+/i.test(normalized);
    // Return SECURITY_RISK if either actual data OR intent to share is detected
    if (hasActualData || securityRiskPatterns.some(p => p.test(normalized))) {
      return INTENT.SECURITY_RISK;
    }
  }
  
  // Off-topic detection - math, general knowledge, jokes
  const offTopicPatterns = [
    /^(what is|what's|how much|calculate|solve)\s+\d+/,  // Math questions
    /^\d+\s*[+\-*/]\s*\d+/,                              // Math expressions
    /(tell me a joke|what's the weather|what time is it|how are you)/i,
    /(who is|who was|what is the capital|where is)/i,     // General knowledge
    /^(what is|what's)\s+(today|the weather|the time)/i   // Time/weather questions
  ];
  if (offTopicPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.OFF_TOPIC;
  }
  
  // No issue / no problem detection - user doesn't need help
  const noIssuePatterns = [
    /^(no issue|no problem|i don't have|i dont have|no issues|nothing wrong|everything is fine|all good)/i,
    /(i am facing no|i'm facing no|not facing|don't have any|dont have any)/i
  ];
  if (noIssuePatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CANCEL; // Treat as cancel since user doesn't need help
  }
  
  // Get last system message once for reuse in multiple checks
  const lastSystemMessage = conversationContext.filter(m => m.sender === 'system').slice(-1)[0];
  
  // Confirmation intent (yes/no responses)
  const confirmationPatterns = [
    /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly)$/i,
    /^(no|nope|nah|not really|incorrect|wrong|that's wrong)$/i
  ];
  // Only treat as confirmation if we're in confirmation mode or last question was confirmation
  if (lastSystemMessage && confirmationPatterns.some(pattern => pattern.test(normalized))) {
    const lastQuestion = lastSystemMessage.message?.toLowerCase() || '';
    if (lastQuestion.includes('submit') || lastQuestion.includes('correct') || lastQuestion.includes('confirm')) {
      return INTENT.CONFIRMATION;
    }
  }
  
  // Submission keywords
  const submissionKeywords = [
    'submit', 'send', 'create ticket', 'open ticket', 'raise ticket',
    'contact support', 'i need help now', 'please submit', 'go ahead',
    'that\'s all', 'that is all', 'done', 'finish', 'complete'
  ];
  
  if (submissionKeywords.some(keyword => normalized.includes(keyword))) {
    return INTENT.SUBMIT_REQUEST;
  }
  
  // Greeting patterns (only at start of conversation or after long pause)
  const greetingPatterns = [
    /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)/i,
    /^(hi there|hello there|hey there)/i
  ];
  
  // Check if this is likely a greeting (only if it's a greeting word and conversation is short or empty)
  if (greetingPatterns.some(pattern => pattern.test(normalized))) {
    // Only treat as greeting if conversation is very short or this is clearly a greeting phrase
    if (conversationContext.length <= 2 || normalized.match(/^(hi|hello|hey|greetings|good (morning|afternoon|evening))/i)) {
      return INTENT.GREETING;
    }
  }
  
  // Frustration signals
  const frustrationPatterns = [
    /(i already told you|i said|you already asked|why are you asking|stop asking|again\?)/i,
    /(i don'?t know|i dont know|dunno|no idea|not sure)/i,
    /(this is frustrating|annoying|ridiculous)/i
  ];
  
  // Check for repeated "I don't know" in recent messages (with or without apostrophe)
  const recentMessages = conversationContext.slice(-4).map(m => m.message?.toLowerCase() || '');
  const dontKnowCount = recentMessages.filter(m => 
    m.includes("i don't know") || m.includes("i dont know") || m.includes("dunno")
  ).length;
  
  if (frustrationPatterns.some(pattern => pattern.test(normalized)) || dontKnowCount >= 2) {
    return INTENT.FRUSTRATION;
  }
  
  // Correction intent - user correcting previous answer
  const correctionPatterns = [
    /(i meant|i mean|actually|correction|let me correct|that's wrong|i said wrong)/i,
    /(not|no,|wait,|actually it's|it's actually)/i
  ];
  // Only if there's conversation history (user correcting something)
  if (conversationContext.length > 2 && correctionPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CORRECT_PREVIOUS;
  }
  
  // Confused intent - user doesn't understand
  const confusedPatterns = [
    /(i don't understand|i'm confused|what do you mean|what does that mean|huh\?|what\?)/i,
    /(i don't get it|can you explain|i'm not sure what you mean)/
  ];
  if (confusedPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CONFUSED;
  }
  
  // Clarification signals (user asking bot to clarify)
  const clarificationPatterns = [
    /(what do you mean|can you clarify|i don't understand|what does that mean)/i,
    /(repeat|say again|what was that|pardon|sorry\?)/i,
    /(what.*do.*u.*mean|what.*do.*you.*mean)/i,
    /(what.*ticket|what.*is.*ticket|what.*are.*you.*talking|what.*are.*u.*talking)/i,
    /(i don't get it|i dont get it|what.*that.*mean|what.*this.*mean)/i,
    /(explain|can you explain|what.*you.*mean|what.*u.*mean)/i
  ];
  
  if (clarificationPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CLARIFICATION;
  }
  
  // Context-aware answer detection: If there's a recent question, short answers are likely answers
  // Reuse lastSystemMessage from confirmation check above if it exists
  if (lastSystemMessage) {
    const lastQuestion = lastSystemMessage.message?.toLowerCase() || '';
    
    // If last question was about urgency, category, system, etc., and user gives short answer, it's likely an ANSWER
    const questionKeywords = {
      urgency: ['urgency', 'urgent', 'priority', 'how urgent', 'blocked', 'high', 'medium', 'low'],
      category: ['category', 'type', 'kind', 'which category'],
      system: ['system', 'application', 'app', 'which system', 'what system'],
      issue: ['issue', 'problem', 'what', 'describe'],
      error: ['error', 'error message', 'error text']
    };
    
    // Check if last question matches any category
    const questionType = Object.keys(questionKeywords).find(key => 
      questionKeywords[key].some(kw => lastQuestion.includes(kw))
    );
    
    if (questionType) {
      // Short answers to specific questions are likely answers
      if (normalized.length <= 20) {
        // Check if answer matches expected values
        if (questionType === 'urgency' && ['blocked', 'high', 'medium', 'low'].includes(normalized)) {
          return INTENT.ANSWER;
        }
        if (questionType === 'category' && ['password', 'hardware', 'software', 'network', 'email', 'other'].includes(normalized)) {
          return INTENT.ANSWER;
        }
        // For other question types, if it's a short response and not a greeting, treat as answer
        if (!greetingPatterns.some(pattern => pattern.test(normalized))) {
          return INTENT.ANSWER;
        }
      }
    }
  }
  
  // Provide info intent - user providing information (more specific than generic ANSWER)
  // Check if last question was asking for specific field and user provides substantial response
  if (lastExpectedField && normalized.length > 5) {
    // User likely answering the last question
    return INTENT.PROVIDE_INFO;
  }
  
  // If message is substantial (> 10 chars) and not a greeting, likely an ANSWER
  if (normalized.length > 10 && !greetingPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.ANSWER;
  }
  
  return null; // Unclear, need AI fallback
};

/**
 * AI-based intent classification (fallback when rules are unclear)
 * Enhanced with new intents and better context understanding
 */
const classifyIntentWithAI = async (userMessage, conversationContext = [], lastExpectedField = null) => {
  if (!isOpenAIAvailable() || !openai) {
    return INTENT.UNKNOWN;
  }
  
  // Build conversation context string
  const contextStr = conversationContext.slice(-3).map(msg => {
    const role = msg.sender === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.message}`;
  }).join('\n');
  
  const lastQuestionContext = lastExpectedField 
    ? `\nLast question was about: ${lastExpectedField}` 
    : '';
  
  const prompt = `Classify the user's intent from their message. Choose ONE intent:

INTENTS:
- GREETING: User is greeting or starting conversation
- PROVIDE_INFO: User is providing information to answer a question
- ANSWER: User is answering a question or providing information (generic)
- CORRECT_PREVIOUS: User is correcting a previous answer they gave
- CLARIFICATION: User is asking the bot to clarify or repeat something
- CONFUSED: User is confused or doesn't understand what was asked
- OFF_TOPIC: User message is off-topic (math, jokes, general knowledge, unrelated)
- SECURITY_RISK: User intends to share sensitive data (password, PIN, code, token)
- SUBMIT_REQUEST: User wants to submit/create ticket now
- CONFIRMATION: User confirming yes/no to a question (usually about submission)
- FRUSTRATION: User is frustrated, repeating themselves, or saying "I don't know"
- CANCEL: User wants to cancel or abandon the ticket
- UNKNOWN: Cannot determine intent

${contextStr ? `Recent conversation:\n${contextStr}\n` : ''}${lastQuestionContext}
User message: "${userMessage}"

Respond with ONLY the intent name (e.g., "PROVIDE_INFO" or "OFF_TOPIC"). No explanation.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are an intent classifier. Respond with only the intent name.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 20
    });
    
    const intent = completion.choices[0]?.message?.content?.trim().toUpperCase();
    
    // Validate intent
    if (Object.values(INTENT).includes(intent)) {
      return intent;
    }
    
    return INTENT.UNKNOWN;
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Intent] AI classification error:', error.message);
    }
    return INTENT.UNKNOWN;
  }
};

/**
 * Classify user intent (rule-based first, AI fallback)
 * Enhanced with conversation state awareness
 * @param {string} userMessage - User's message
 * @param {Array} conversationContext - Recent messages for context
 * @param {string} lastExpectedField - Field the bot was asking about (for correlation)
 * @returns {Promise<{intent: string, confidence: string}>} Intent classification with confidence
 */
export const classifyIntent = async (userMessage, conversationContext = [], lastExpectedField = null) => {
  if (!userMessage || typeof userMessage !== 'string') {
    return { intent: INTENT.UNKNOWN, confidence: 'low' };
  }
  
  // Try rule-based detection first (fast, deterministic)
  const ruleBasedIntent = detectIntentRules(userMessage, conversationContext, lastExpectedField);
  
  if (ruleBasedIntent) {
    if (ENABLE_LOGGING) {
      console.log('[Intent] Rule-based:', ruleBasedIntent);
    }
    // Rule-based detection is high confidence (deterministic patterns)
    return { intent: ruleBasedIntent, confidence: 'high' };
  }
  
  // Fallback to AI if unclear
  const aiIntent = await classifyIntentWithAI(userMessage, conversationContext, lastExpectedField);
  
  if (ENABLE_LOGGING) {
    console.log('[Intent] AI-based:', aiIntent);
  }
  
  // AI classification is medium confidence (can be uncertain)
  return { intent: aiIntent, confidence: 'medium' };
};

export default {
  classifyIntent,
  INTENT
};

