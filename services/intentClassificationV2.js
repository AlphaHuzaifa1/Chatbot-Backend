/**
 * INTENT CLASSIFICATION V2
 * 
 * Semantic intent understanding using LLM with confidence scoring.
 * NO keyword matching - pure semantic interpretation.
 * 
 * Required intents:
 * - provide_info: User providing information
 * - ask_question: User asking bot a question
 * - add_more_info: User wants to add more information
 * - interrupt_wait: User saying "wait", "hold on", etc.
 * - confirm_submit: User confirming submission
 * - deny_submit: User declining submission
 * - no_more_info: User saying "that's all", "nothing more"
 * - frustration: User frustrated or confused
 * - idle: Unclear or empty message
 * - security_risk: User intends to share sensitive data
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const INTENT_CONFIDENCE_THRESHOLD = parseFloat(process.env.INTENT_CONFIDENCE_THRESHOLD || '0.6');

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
} else {
  console.warn('OPENAI_API_KEY not configured. Intent classification will fail.');
}

/**
 * Supported intents
 */
export const INTENT = {
  PROVIDE_INFO: 'provide_info',
  ASK_QUESTION: 'ask_question',
  ADD_MORE_INFO: 'add_more_info',
  INTERRUPT_WAIT: 'interrupt_wait',
  CONFIRM_SUBMIT: 'confirm_submit',
  DENY_SUBMIT: 'deny_submit',
  NO_MORE_INFO: 'no_more_info',
  FRUSTRATION: 'frustration',
  IDLE: 'idle',
  SECURITY_RISK: 'security_risk',
  OFF_TOPIC: 'off_topic'
};

/**
 * Classify user intent with semantic understanding
 * 
 * @param {string} userMessage - User's message
 * @param {Object} context - Conversation context
 * @param {string} context.lastBotMessage - Last message from bot
 * @param {string} context.conversationState - Current state
 * @param {Array} context.recentMessages - Last 3-4 message pairs
 * @returns {Promise<{intent: string, confidence: number, reasoning: string}>}
 */
export const classifyIntent = async (userMessage, context = {}) => {
  if (!openai) {
    // Fallback: return most likely intent with low confidence
    return {
      intent: INTENT.PROVIDE_INFO,
      confidence: 0.3,
      reasoning: 'LLM not available - using fallback'
    };
  }

  const { lastBotMessage = '', conversationState = 'INIT', recentMessages = [] } = context;

  // Build conversation context
  const conversationContext = recentMessages.slice(-4).map(msg => {
    const role = msg.sender === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.message}`;
  }).join('\n');

  const systemPrompt = `You are an intent classifier for a support chatbot. Your job is to understand the SEMANTIC MEANING of user messages, not just keywords.

CURRENT STATE: ${conversationState}
${lastBotMessage ? `LAST BOT MESSAGE: "${lastBotMessage}"` : ''}

${conversationContext ? `RECENT CONVERSATION:\n${conversationContext}\n` : ''}

USER MESSAGE: "${userMessage}"

Classify the user's intent. Consider:
1. The FULL MEANING of the message, not just keywords
2. The conversation context (what was just asked)
3. The current state (what the bot is doing)
4. User's emotional state (frustrated, confused, etc.)

AVAILABLE INTENTS:
- provide_info: User is providing information to answer a question or describing their issue. This is the DEFAULT for most messages that contain information.
- ask_question: User is asking the bot a question about IT support (e.g., "what do you mean?", "can you explain?", "what is that?")
- add_more_info: User explicitly wants to add more information (e.g., "let me add", "one more thing", "I want to add")
- interrupt_wait: User wants to pause (e.g., "wait", "hold on", "let me think", "give me a moment", "pause")
- confirm_submit: User explicitly confirming submission (e.g., "yes", "submit", "go ahead", "that's correct")
- deny_submit: User declining submission (e.g., "no", "not yet", "wait", "don't submit")
- no_more_info: User saying they're done (e.g., "that's all", "nothing more", "that's everything", "I'm done")
- frustration: User is frustrated, confused, or repeating themselves (e.g., "I already told you", "I don't know", "this is frustrating")
- idle: Message is unclear or empty (NOT for greetings or issue descriptions)
- off_topic: User message is completely off-topic - math questions, general knowledge, jokes, greetings without issue, or anything NOT related to IT support (e.g., "how are you", "what is 2+2", "tell me a joke", "what's the weather")
- security_risk: User intends to share sensitive data (passwords, PINs, codes, tokens, MFA codes)

CRITICAL: This is an IT SUPPORT chatbot. If the user asks about math, general knowledge, jokes, or casual conversation without mentioning an IT issue, classify as off_topic.

IMPORTANT RULES:
- If user describes ANY technical issue, use provide_info (NOT idle, NOT off_topic)
- Greetings like "Hi" followed by issue description should be provide_info
- Greetings like "Hi" or "how are you" WITHOUT issue description should be off_topic
- Math questions, general knowledge, jokes, weather, time = off_topic
- Only use idle for truly unclear or empty messages
- If user says "wait" or "hold on", use interrupt_wait (NOT provide_info)
- If user says "that's all" or "nothing more", use no_more_info
- If user is frustrated or confused, use frustration
- If user intends to share passwords/codes, use security_risk
- THIS IS AN IT SUPPORT CHATBOT - redirect off-topic questions back to IT support

Respond with JSON:
{
  "intent": "intent_name",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this intent"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Classify this message: "${userMessage}"` }
      ],
      temperature: 0.2, // Low temperature for consistent classification
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from intent classifier');
    }

    const result = JSON.parse(content);

  // Validate intent
  const validIntents = Object.values(INTENT);
  if (!validIntents.includes(result.intent)) {
    if (ENABLE_LOGGING) {
      console.warn('[Intent] Invalid intent returned:', result.intent);
    }
    // Default to provide_info if invalid
    result.intent = INTENT.PROVIDE_INFO;
    result.confidence = 0.5;
  }

  // Quick check for obvious off-topic (fallback if LLM misses it)
  const normalized = userMessage.toLowerCase().trim();
  const offTopicPatterns = [
    /^(how are you|how are u|what's up|whats up|hi|hello|hey)$/i,
    /^(what is|what's)\s+\d+\s*[+\-*/]\s*\d+/i, // Math questions
    /^\d+\s*[+\-*/]\s*\d+/, // Math expressions
    /^(tell me a joke|what's the weather|what time is it)/i,
    /^(who is|who was|what is the capital)/i
  ];
  
  if (offTopicPatterns.some(pattern => pattern.test(normalized)) && 
      result.intent !== INTENT.PROVIDE_INFO && 
      !normalized.includes('issue') && 
      !normalized.includes('problem') &&
      !normalized.includes('error')) {
    result.intent = INTENT.OFF_TOPIC;
    result.confidence = 0.9;
  }

    // Validate confidence
    if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
      result.confidence = 0.5;
    }

    if (ENABLE_LOGGING) {
      console.log('[Intent Classification]', {
        intent: result.intent,
        confidence: result.confidence,
        reasoning: result.reasoning
      });
    }

    return {
      intent: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning || 'No reasoning provided'
    };
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Intent Classification] Error:', error.message);
    }
    // Fallback
    return {
      intent: INTENT.PROVIDE_INFO,
      confidence: 0.3,
      reasoning: `Classification failed: ${error.message}`
    };
  }
};

/**
 * Check if intent confidence is above threshold
 */
export const isIntentConfident = (confidence) => {
  return confidence >= INTENT_CONFIDENCE_THRESHOLD;
};

/**
 * Get fallback intent if confidence is too low
 */
export const getFallbackIntent = (userMessage, conversationState) => {
  const normalized = userMessage.toLowerCase().trim();
  
  // Very basic fallback patterns (only for extreme cases)
  if (normalized.length === 0 || normalized === '?') {
    return INTENT.IDLE;
  }
  
  if (normalized.includes('wait') || normalized.includes('hold on')) {
    return INTENT.INTERRUPT_WAIT;
  }
  
  // Check for submission confirmation patterns
  const submitPatterns = [
    /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that'?s\s+right|exactly|go\s+ahead|submit)/i,
    /(yes|yeah|yep|yup|sure|ok|okay).*(kindly|please|can\s+you|will\s+you).*(submit|create|open|raise|send).*(ticket|it)/i,
    /(kindly|please).*(submit|create|open|raise|send).*(ticket|it)/i,
    /(submit|create|open|raise|send).*(ticket|it).*(please|kindly|now)/i,
    /^(yes|yeah|yep|yup|sure|ok|okay).*(submit|create|open|raise|send)/i
  ];
  
  if (submitPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CONFIRM_SUBMIT;
  }
  
  if (normalized === 'no' || normalized === 'not yet') {
    return INTENT.DENY_SUBMIT;
  }
  
  // Check for off-topic
  if (/^(how are you|how are u|what's up|whats up|hi|hello|hey)$/i.test(normalized) ||
      /^(what is|what's)\s+\d+\s*[+\-*/]\s*\d+/i.test(normalized) ||
      /^\d+\s*[+\-*/]\s*\d+/.test(normalized)) {
    return INTENT.OFF_TOPIC;
  }
  
  // Default to provide_info
  return INTENT.PROVIDE_INFO;
};

export default {
  classifyIntent,
  isIntentConfident,
  getFallbackIntent,
  INTENT
};

