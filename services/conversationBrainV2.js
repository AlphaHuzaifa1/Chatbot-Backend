/**
 * CONVERSATION BRAIN V2
 * 
 * The "reasoning layer" that runs BEFORE field extraction.
 * Understands full user intent and decides what action to take.
 * 
 * Key Principles:
 * 1. Conversation-first, fields second
 * 2. Acknowledge before asking
 * 3. Extract multiple fields from single message
 * 4. Never ask for information already provided
 * 5. Respect interruptions and pauses
 * 
 * The Brain decides:
 * - Should I acknowledge what the user said?
 * - What fields can I extract from this message?
 * - Should I ask a follow-up question?
 * - Should I wait, clarify, or submit?
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildConversationSummary, getConversationContext } from './conversationMemoryService.js';
import { CONVERSATION_STATE } from './conversationStateMachineV2.js';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
}

/**
 * Conversation Brain: Decide what action to take next
 * 
 * This runs BEFORE field extraction and question generation.
 * It reasons over the full conversation context.
 * 
 * @param {string} userMessage - Current user message
 * @param {Object} sessionState - Full session state
 * @param {string} intent - Classified intent
 * @param {number} intentConfidence - Intent confidence score
 * @returns {Promise<Object>} Brain decision
 */
export const reasonAboutConversation = async (userMessage, sessionState, intent, intentConfidence) => {
  if (!openai) {
    return reasonAboutConversationFallback(userMessage, sessionState, intent);
  }

  const summary = buildConversationSummary(sessionState);
  const context = getConversationContext(sessionState);
  const { conversationState, lastBotQuestion, lastExpectedField } = sessionState;

  // Build system prompt
  const systemPrompt = `You are the Conversation Brain for a support chatbot. Your job is to understand the conversation flow and decide what to do next.

You are NOT a form-filling bot. You are a human-like support agent who:
- Understands what the user is trying to communicate
- Remembers what was already discussed
- Acknowledges what the user said before asking new questions
- Extracts multiple pieces of information from a single message when possible
- Never asks for information the user already clearly provided
- Never asks the same question twice unless the user contradicts themselves
- Respects user pauses and interruptions

CURRENT STATE: ${conversationState}

CONVERSATION SUMMARY:
${context.type === 'summary' 
  ? `Summary: ${context.content}\n\nRecent turns:\n${context.recentMessages.map((msg, i) => `${msg.sender}: ${msg.message}`).join('\n')}`
  : `Recent conversation:\n${context.content.map((msg, i) => `${msg.sender}: ${msg.message}`).join('\n')}`
}

WHAT WE KNOW:
${summary.confirmedInfo.join('\n')}

WHAT WE STILL NEED:
${summary.missingInfo.join('\n')}

${lastBotQuestion ? `LAST QUESTION ASKED: "${lastBotQuestion}"` : ''}
${lastExpectedField ? `LAST QUESTION WAS ABOUT: ${lastExpectedField}` : ''}

USER'S CURRENT MESSAGE: "${userMessage}"
USER'S INTENT: ${intent} (confidence: ${intentConfidence.toFixed(2)})

Your task: Decide what action to take next. Consider:
1. Does the user's message answer the last question? If yes, acknowledge it.
2. Can I extract multiple fields from this single message? If yes, extract all of them.
3. Is the user providing new information, correcting something, refusing, or going off-topic?
4. Should I acknowledge what I understood before asking anything new?
5. Should I ask a follow-up question, or do I have enough information?
6. If user said "wait" or "hold on", respect the pause.
7. If user said "that's all", check if we have minimum required fields.

Respond in JSON format:
{
  "action": "ACKNOWLEDGE_AND_EXTRACT" | "ACKNOWLEDGE_ONLY" | "EXTRACT_MULTIPLE" | "ASK_CLARIFICATION" | "WAIT" | "SHOW_SUMMARY" | "REDIRECT_OFF_TOPIC",
  "reasoning": "Brief explanation of why this action",
  "shouldAcknowledge": boolean,
  "acknowledgment": "Natural language acknowledgment of what user said (if shouldAcknowledge is true)",
  "fieldsToExtract": ["problem", "category", "urgency", "affectedSystem", "errorText"] or null,
  "shouldAskQuestion": boolean,
  "questionToAsk": "Question to ask (if shouldAskQuestion is true)" or null,
  "nextState": "PROBING" | "CLARIFYING" | "WAITING" | "READY_TO_SUBMIT" | null (null = stay in current state)
}

Rules:
- If user provided substantial information, ALWAYS acknowledge it first
- Extract ALL fields you can identify from the message, not just one
- Never ask for information the user already clearly provided
- If user said "wait", action must be "WAIT" and nextState must be "WAITING"
- If user said "that's all" and we have minimum fields, action should be "SHOW_SUMMARY"
- Be conversational and human-like, not robotic
- Only suggest state transitions - backend will enforce them`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the conversation and decide what to do next.` }
      ],
      temperature: 0.3, // Lower temperature for consistent reasoning
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
      'WAIT',
      'SHOW_SUMMARY',
      'REDIRECT_OFF_TOPIC'
    ];

    if (!validActions.includes(decision.action)) {
      if (ENABLE_LOGGING) {
        console.warn('[Conversation Brain] Invalid action, using fallback');
      }
      return reasonAboutConversationFallback(userMessage, sessionState, intent);
    }

    // Enforce intent-based constraints
    if (intent === 'interrupt_wait') {
      decision.action = 'WAIT';
      decision.nextState = 'WAITING';
      decision.shouldAcknowledge = true;
      decision.acknowledgment = "No problem, take your time. Just let me know when you're ready to continue.";
    }

    if (intent === 'no_more_info' && summary.missingInfo.length === 0) {
      decision.action = 'SHOW_SUMMARY';
      decision.nextState = 'READY_TO_SUBMIT';
    }

    if (intent === 'security_risk') {
      decision.action = 'REDIRECT_OFF_TOPIC';
      decision.acknowledgment = "For security reasons, I cannot accept passwords, PINs, codes, or tokens through this chat. If you need password reset assistance, I can guide you through the proper process.";
    }

    // Handle off-topic questions
    if (intent === 'off_topic') {
      decision.action = 'REDIRECT_OFF_TOPIC';
      decision.shouldAcknowledge = true;
      decision.acknowledgment = "I'm here to help with IT support issues. What technical problem are you experiencing?";
      decision.shouldAskQuestion = false;
      decision.fieldsToExtract = null;
      decision.nextState = null; // Stay in current state
    }

    if (ENABLE_LOGGING) {
      console.log('[Conversation Brain] Decision:', {
        action: decision.action,
        reasoning: decision.reasoning,
        shouldAcknowledge: decision.shouldAcknowledge,
        fieldsToExtract: decision.fieldsToExtract,
        nextState: decision.nextState
      });
    }

    return decision;
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Conversation Brain] Error:', error.message);
    }
    return reasonAboutConversationFallback(userMessage, sessionState, intent);
  }
};

/**
 * Fallback reasoning when OpenAI is unavailable
 */
const reasonAboutConversationFallback = async (userMessage, sessionState, intent) => {
  const summary = buildConversationSummary(sessionState);

  // Handle off-topic
  if (intent === 'off_topic') {
    return {
      action: 'REDIRECT_OFF_TOPIC',
      reasoning: 'User message is off-topic',
      shouldAcknowledge: true,
      acknowledgment: "I'm here to help with IT support issues. What technical problem are you experiencing?",
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      nextState: null
    };
  }

  // Handle specific intents
  if (intent === 'interrupt_wait') {
    return {
      action: 'WAIT',
      reasoning: 'User wants to pause',
      shouldAcknowledge: true,
      acknowledgment: "No problem, take your time. Just let me know when you're ready to continue.",
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      nextState: 'WAITING'
    };
  }

  if (intent === 'no_more_info' && summary.missingInfo.length === 0) {
    return {
      action: 'SHOW_SUMMARY',
      reasoning: 'User says that\'s all and we have all fields',
      shouldAcknowledge: true,
      acknowledgment: 'Thank you. I have all the information I need.',
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      nextState: 'READY_TO_SUBMIT'
    };
  }

  if (intent === 'security_risk') {
    return {
      action: 'REDIRECT',
      reasoning: 'Security risk detected',
      shouldAcknowledge: true,
      acknowledgment: "For security reasons, I cannot accept passwords, PINs, codes, or tokens through this chat.",
      fieldsToExtract: null,
      shouldAskQuestion: false,
      questionToAsk: null,
      nextState: null
    };
  }

  // Default: extract and ask
  return {
    action: 'EXTRACT_MULTIPLE',
    reasoning: 'Extract information from user message and ask for missing fields',
    shouldAcknowledge: userMessage.length > 20,
    acknowledgment: userMessage.length > 20 ? 'Thanks for that information.' : null,
    fieldsToExtract: ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'],
    shouldAskQuestion: summary.missingInfo.length > 0,
    questionToAsk: null, // Will be generated later
    nextState: null
  };
};

export default {
  reasonAboutConversation
};

