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
 * Supported intents
 */
export const INTENT = {
  GREETING: 'GREETING',
  ANSWER: 'ANSWER',
  CLARIFICATION: 'CLARIFICATION',
  UNKNOWN: 'UNKNOWN',
  SUBMIT_REQUEST: 'SUBMIT_REQUEST',
  FRUSTRATION: 'FRUSTRATION'
};

/**
 * Rule-based intent detection (fast, deterministic)
 */
const detectIntentRules = (userMessage, conversationContext = []) => {
  const normalized = userMessage.toLowerCase().trim();
  
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
  
  // Clarification signals
  const clarificationPatterns = [
    /(what do you mean|can you clarify|i don't understand|what does that mean)/i,
    /(repeat|say again|what was that|pardon|sorry\?)/i,
    /(i meant|i mean|actually|correction|let me clarify)/i
  ];
  
  if (clarificationPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.CLARIFICATION;
  }
  
  // Context-aware answer detection: If there's a recent question, short answers are likely answers
  const lastSystemMessage = conversationContext.filter(m => m.sender === 'system').slice(-1)[0];
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
  
  // If message is substantial (> 10 chars) and not a greeting, likely an ANSWER
  if (normalized.length > 10 && !greetingPatterns.some(pattern => pattern.test(normalized))) {
    return INTENT.ANSWER;
  }
  
  return null; // Unclear, need AI fallback
};

/**
 * AI-based intent classification (fallback when rules are unclear)
 */
const classifyIntentWithAI = async (userMessage, conversationContext = []) => {
  if (!isOpenAIAvailable() || !openai) {
    return INTENT.UNKNOWN;
  }
  
  // Build conversation context string
  const contextStr = conversationContext.slice(-3).map(msg => {
    const role = msg.sender === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.message}`;
  }).join('\n');
  
  const prompt = `Classify the user's intent from their message. Choose ONE intent:

INTENTS:
- GREETING: User is greeting or starting conversation
- ANSWER: User is answering a question or providing information
- CLARIFICATION: User is asking for clarification or correcting something
- SUBMIT_REQUEST: User wants to submit/create ticket now
- FRUSTRATION: User is frustrated, repeating themselves, or saying "I don't know"
- UNKNOWN: Cannot determine intent

${contextStr ? `Recent conversation:\n${contextStr}\n` : ''}
User message: "${userMessage}"

Respond with ONLY the intent name (e.g., "ANSWER" or "CLARIFICATION"). No explanation.`;

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
 * @param {string} userMessage - User's message
 * @param {Array} conversationContext - Recent messages for context
 * @returns {Promise<string>} Intent classification
 */
export const classifyIntent = async (userMessage, conversationContext = []) => {
  if (!userMessage || typeof userMessage !== 'string') {
    return INTENT.UNKNOWN;
  }
  
  // Try rule-based detection first
  const ruleBasedIntent = detectIntentRules(userMessage, conversationContext);
  
  if (ruleBasedIntent) {
    if (ENABLE_LOGGING) {
      console.log('[Intent] Rule-based:', ruleBasedIntent);
    }
    return ruleBasedIntent;
  }
  
  // Fallback to AI if unclear
  const aiIntent = await classifyIntentWithAI(userMessage, conversationContext);
  
  if (ENABLE_LOGGING) {
    console.log('[Intent] AI-based:', aiIntent);
  }
  
  return aiIntent;
};

export default {
  classifyIntent,
  INTENT
};

