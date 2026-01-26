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
 * Conversation Brain Service
 * 
 * This is the "reasoning layer" that runs BEFORE field extraction and question generation.
 * It understands the full conversation context and decides what action to take.
 * 
 * Mental Model: Conversation-first, fields second
 * - The bot reasons over what it already knows
 * - Decides whether to ask, clarify, acknowledge, wait, or submit
 * - Intake fields are a by-product of understanding, not the driver
 */

/**
 * Build structured conversation summary
 * This replaces raw message history with a reasoned summary
 */
const buildConversationSummary = (sessionState) => {
  const intake = sessionState.intake || {};
  const messages = sessionState.messages || [];
  const askedQuestions = sessionState.askedQuestions || [];
  
  // Build known facts
  const knownFacts = [];
  if (intake.issue) knownFacts.push(`Issue: ${intake.issue}`);
  if (intake.category) knownFacts.push(`Category: ${intake.category}`);
  if (intake.urgency) knownFacts.push(`Urgency: ${intake.urgency}`);
  if (intake.affectedSystem) knownFacts.push(`Affected System: ${intake.affectedSystem}`);
  if (intake.errorText && intake.errorText !== 'no error provided') {
    knownFacts.push(`Error Message: ${intake.errorText}`);
  } else if (intake.errorText === 'no error provided') {
    knownFacts.push(`Error Message: None provided`);
  }
  
  // Build missing facts
  const missingFacts = [];
  if (!intake.issue) missingFacts.push('issue description');
  if (!intake.category) missingFacts.push('category');
  if (!intake.urgency) missingFacts.push('urgency level');
  if (!intake.affectedSystem && intake.category !== 'password') missingFacts.push('affected system');
  if (intake.errorText === null || intake.errorText === undefined) missingFacts.push('error message (or confirmation of none)');
  
  // Build recent conversation flow (last 3-4 turns for context)
  const recentTurns = [];
  const recentMessages = messages.slice(-8); // Last 8 messages = ~4 turns
  for (let i = 0; i < recentMessages.length - 1; i += 2) {
    const userMsg = recentMessages[i];
    const botMsg = recentMessages[i + 1];
    if (userMsg && userMsg.sender === 'user' && botMsg && botMsg.sender === 'system') {
      recentTurns.push({
        user: userMsg.message,
        bot: botMsg.message
      });
    }
  }
  
  return {
    knownFacts: knownFacts.length > 0 ? knownFacts : ['No information collected yet'],
    missingFacts: missingFacts.length > 0 ? missingFacts : ['All required information collected'],
    recentConversation: recentTurns,
    lastBotQuestion: sessionState.lastBotQuestion || null,
    lastExpectedField: sessionState.lastExpectedField || null,
    askedQuestionsCount: askedQuestions.length,
    conversationMode: sessionState.conversationMode || 'INTAKE',
    submissionDeclined: sessionState.submissionDeclined || false
  };
};

/**
 * Conversation Brain: Decide what action to take next
 * 
 * This runs BEFORE field extraction and question generation.
 * It reasons over the full conversation context and decides:
 * - Should I acknowledge what the user just said?
 * - Should I extract multiple fields from this message?
 * - Should I ask a follow-up question?
 * - Should I clarify something?
 * - Should I submit?
 * - Should I wait for more information?
 * 
 * @param {string} userMessage - Current user message
 * @param {Object} sessionState - Full session state
 * @param {string} intent - Classified intent
 * @returns {Promise<Object>} Brain decision with action and reasoning
 */
export const reasonAboutConversation = async (userMessage, sessionState, intent) => {
  if (!isOpenAIAvailable() || !openai) {
    // Fallback: basic reasoning without AI
    return await reasonAboutConversationFallback(userMessage, sessionState, intent);
  }
  
  const summary = buildConversationSummary(sessionState);
  const intake = sessionState.intake || {};
  
  // Build system prompt for conversation reasoning
  const systemPrompt = `You are a conversational AI support agent. Your job is to understand the conversation flow and decide what to do next.

You are NOT a form-filling bot. You are a human-like support agent who:
- Understands what the user is trying to communicate
- Remembers what was already discussed
- Acknowledges what the user said before asking new questions
- Extracts multiple pieces of information from a single message when possible
- Never asks for information the user already clearly provided
- Never asks the same question twice unless the user contradicts themselves

Current conversation state:
${summary.knownFacts.length > 0 ? `\nWhat we know:\n${summary.knownFacts.map(f => `- ${f}`).join('\n')}` : '\nNo information collected yet.'}
${summary.missingFacts.length > 0 ? `\nWhat we still need:\n${summary.missingFacts.map(f => `- ${f}`).join('\n')}` : '\nAll required information collected.'}
${summary.lastBotQuestion ? `\nLast question asked: "${summary.lastBotQuestion}"` : ''}
${summary.lastExpectedField ? `\nLast question was about: ${summary.lastExpectedField}` : ''}
${summary.submissionDeclined ? '\n⚠️ User previously declined submission - do NOT auto-submit' : ''}
${summary.conversationMode !== 'INTAKE' ? `\nCurrent mode: ${summary.conversationMode}` : ''}

Recent conversation:
${summary.recentConversation.length > 0 
  ? summary.recentConversation.map((turn, idx) => 
      `Turn ${idx + 1}:\nUser: ${turn.user}\nBot: ${turn.bot}`
    ).join('\n\n')
  : 'No recent conversation yet.'
}

User's current message: "${userMessage}"
User's intent: ${intent}

Your task: Decide what action to take next. Consider:
1. Does the user's message answer the last question? If yes, acknowledge it.
2. Can I extract multiple fields from this single message? If yes, extract all of them.
3. Is the user providing new information, correcting something, refusing, or going off-topic?
4. Should I acknowledge what I understood before asking anything new?
5. Should I ask a follow-up question, or do I have enough information?
6. If user said "no" to submission, do NOT submit automatically.

Respond in JSON format:
{
  "action": "ACKNOWLEDGE_AND_EXTRACT" | "ACKNOWLEDGE_ONLY" | "EXTRACT_MULTIPLE" | "ASK_CLARIFICATION" | "SUBMIT" | "WAIT" | "REDIRECT_OFF_TOPIC",
  "reasoning": "Brief explanation of why this action",
  "shouldAcknowledge": boolean,
  "acknowledgment": "Natural language acknowledgment of what user said (if shouldAcknowledge is true)",
  "fieldsToExtract": ["field1", "field2", ...] or null,
  "shouldAskQuestion": boolean,
  "questionToAsk": "Question to ask (if shouldAskQuestion is true)" or null,
  "confidence": "high" | "medium" | "low"
}

Rules:
- If user provided substantial information, ALWAYS acknowledge it first
- Extract ALL fields you can identify from the message, not just one
- Never ask for information the user already clearly provided
- If user said "no" to submission, action must NOT be "SUBMIT"
- If user is off-topic, redirect them back to IT support
- Be conversational and human-like, not robotic`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the conversation and decide what to do next.` }
      ],
      temperature: 0.3, // Lower temperature for more consistent reasoning
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });
    
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from conversation brain');
    }
    
    const decision = JSON.parse(content);
    
    // Validate decision structure
    if (!decision.action || !decision.reasoning) {
      throw new Error('Invalid decision structure from conversation brain');
    }
    
    // Validate action
    const validActions = [
      'ACKNOWLEDGE_AND_EXTRACT',
      'ACKNOWLEDGE_ONLY',
      'EXTRACT_MULTIPLE',
      'ASK_CLARIFICATION',
      'SUBMIT',
      'WAIT',
      'REDIRECT_OFF_TOPIC'
    ];
    
    if (!validActions.includes(decision.action)) {
      if (ENABLE_LOGGING) {
        console.warn('[Conversation Brain] Invalid action, using fallback');
      }
      return await reasonAboutConversationFallback(userMessage, sessionState, intent);
    }
    
    // Enforce submission_declined flag
    if (summary.submissionDeclined && decision.action === 'SUBMIT') {
      if (ENABLE_LOGGING) {
        console.log('[Conversation Brain] User declined submission, overriding SUBMIT action');
      }
      decision.action = 'ACKNOWLEDGE_AND_EXTRACT';
      decision.reasoning = 'User previously declined submission, extracting information instead';
    }
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Brain] Decision:', {
        action: decision.action,
        reasoning: decision.reasoning,
        shouldAcknowledge: decision.shouldAcknowledge,
        fieldsToExtract: decision.fieldsToExtract,
        confidence: decision.confidence
      });
    }
    
    return decision;
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Conversation Brain] Error:', error.message);
    }
    // Fallback to basic reasoning
    return await reasonAboutConversationFallback(userMessage, sessionState, intent);
  }
};

/**
 * Fallback reasoning when OpenAI is unavailable
 */
const reasonAboutConversationFallback = async (userMessage, sessionState, intent) => {
  const summary = buildConversationSummary(sessionState);
  const intake = sessionState.intake || {};
  
  // Basic reasoning without AI
  const missingFields = summary.missingFacts.length;
  const hasLastQuestion = !!summary.lastBotQuestion;
  
  // If user is off-topic
  if (intent === 'OFF_TOPIC') {
    return {
      action: 'REDIRECT_OFF_TOPIC',
      reasoning: 'User message is off-topic',
      shouldAcknowledge: false,
      acknowledgment: null,
      fieldsToExtract: null,
      shouldAskQuestion: true,
      questionToAsk: "I'm here to help with your IT support issue. Could you tell me about the technical problem you're experiencing?",
      confidence: 'high'
    };
  }
  
  // If user wants to submit
  if (intent === 'SUBMIT_REQUEST' && !summary.submissionDeclined) {
    return {
      action: 'SUBMIT',
      reasoning: 'User explicitly requested submission',
      shouldAcknowledge: true,
      acknowledgment: 'I understand you want to submit your ticket.',
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      confidence: 'high'
    };
  }
  
  // If user declined submission
  if (summary.submissionDeclined || intent === 'CANCEL') {
    return {
      action: 'ACKNOWLEDGE_AND_EXTRACT',
      reasoning: 'User declined submission, continue gathering information',
      shouldAcknowledge: true,
      acknowledgment: 'No problem. What information would you like to add or update?',
      fieldsToExtract: ['issue', 'category', 'urgency', 'affectedSystem', 'errorText'],
      shouldAskQuestion: true,
      questionToAsk: null, // Will be generated later
      confidence: 'medium'
    };
  }
  
  // If all fields collected
  if (missingFields === 0) {
    return {
      action: 'SUBMIT',
      reasoning: 'All required fields collected',
      shouldAcknowledge: true,
      acknowledgment: 'Thank you. I have all the information I need.',
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      confidence: 'high'
    };
  }
  
  // Default: extract and ask
  return {
    action: 'EXTRACT_MULTIPLE',
    reasoning: 'Extract information from user message and ask for missing fields',
    shouldAcknowledge: userMessage.length > 20, // Acknowledge if substantial message
    acknowledgment: userMessage.length > 20 ? 'Thanks for that information.' : null,
    fieldsToExtract: ['issue', 'category', 'urgency', 'affectedSystem', 'errorText'],
    shouldAskQuestion: true,
    questionToAsk: null, // Will be generated later
    confidence: 'medium'
  };
};

/**
 * Validate extracted fields for garbage/nonsense
 * Rejects clearly invalid extractions
 */
export const validateExtractedFields = (extracted, userMessage, intent) => {
  const validated = {};
  const issues = [];
  
  // Check each extracted field
  for (const [field, value] of Object.entries(extracted)) {
    if (value === null || value === undefined) {
      continue; // Skip null values
    }
    
    // Reject math expressions as issue
    if (field === 'issue' && /^\d+\s*[+\-*/]\s*\d+/.test(value)) {
      issues.push(`Rejected ${field}: "${value}" appears to be a math expression, not an issue`);
      continue;
    }
    
    // Reject single words or very short values for issue
    if (field === 'issue' && value.length < 10 && !['password', 'login', 'email'].some(w => value.toLowerCase().includes(w))) {
      issues.push(`Rejected ${field}: "${value}" is too short or vague`);
      continue;
    }
    
    // Reject off-topic content
    if (intent === 'OFF_TOPIC' && field === 'issue') {
      issues.push(`Rejected ${field}: User message is off-topic`);
      continue;
    }
    
    // Validate category values
    if (field === 'category') {
      const validCategories = ['password', 'hardware', 'software', 'network', 'email', 'other'];
      if (!validCategories.includes(value.toLowerCase())) {
        issues.push(`Rejected ${field}: "${value}" is not a valid category`);
        continue;
      }
    }
    
    // Validate urgency values
    if (field === 'urgency') {
      const validUrgencies = ['blocked', 'high', 'medium', 'low'];
      if (!validUrgencies.includes(value.toLowerCase())) {
        issues.push(`Rejected ${field}: "${value}" is not a valid urgency level`);
        continue;
      }
    }
    
    // If passed validation, include it
    validated[field] = value;
  }
  
  if (ENABLE_LOGGING && issues.length > 0) {
    console.log('[Conversation Brain] Field validation issues:', issues);
  }
  
  return {
    validated,
    issues,
    allValid: issues.length === 0
  };
};

// Export buildConversationSummary for use in other services
export { buildConversationSummary };

export default {
  reasonAboutConversation,
  validateExtractedFields,
  buildConversationSummary
};

