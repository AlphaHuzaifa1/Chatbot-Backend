/**
 * CONVERSATION MEMORY SERVICE
 * 
 * Manages conversation memory with summarization to prevent forgetting.
 * 
 * Memory Structure:
 * - Persistent (DB): Session ID, user context, intake fields, conversation state, submission flags
 * - Ephemeral (session): Last bot question, last expected info, pending interruption, conversation summary
 * 
 * Key Feature: Conversation summarization every N turns
 * - Summary replaces raw message history in LLM calls
 * - Prevents token bloat and forgetting
 * - Includes: problem, confirmed info, missing info, last intent
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const SUMMARIZATION_INTERVAL = parseInt(process.env.SUMMARIZATION_INTERVAL || '8'); // Summarize every 8 turns

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
}

/**
 * Build conversation summary
 * This is the "memory" that replaces raw message history
 */
export const buildConversationSummary = (sessionState) => {
  const { intake, messages = [], conversationState, lastBotQuestion, lastExpectedField } = sessionState;
  
  // What we know (confirmed information)
  const confirmedInfo = [];
  if (intake?.issue) confirmedInfo.push(`Problem: ${intake.issue}`);
  if (intake?.category) confirmedInfo.push(`Category: ${intake.category}`);
  if (intake?.urgency) confirmedInfo.push(`Urgency: ${intake.urgency}`);
  if (intake?.affectedSystem) confirmedInfo.push(`Affected System: ${intake.affectedSystem}`);
  if (intake?.errorText !== null && intake?.errorText !== undefined) {
    if (intake.errorText === 'no error provided') {
      confirmedInfo.push(`Error Message: None provided`);
    } else {
      confirmedInfo.push(`Error Message: ${intake.errorText}`);
    }
  }
  
  // What's still missing
  const missingInfo = [];
  if (!intake?.issue) missingInfo.push('problem description');
  if (!intake?.category) missingInfo.push('category');
  if (!intake?.urgency) missingInfo.push('urgency level');
  if (!intake?.affectedSystem && intake?.category !== 'password') {
    missingInfo.push('affected system');
  }
  if (intake?.errorText === null || intake?.errorText === undefined) {
    missingInfo.push('error message (or confirmation of none)');
  }
  
  // Recent conversation flow (last 2-3 turns for immediate context)
  const recentTurns = [];
  const recentMessages = messages.slice(-6); // Last 6 messages = ~3 turns
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
    // Core information
    problem: intake?.issue || null,
    confirmedInfo: confirmedInfo.length > 0 ? confirmedInfo : ['No information collected yet'],
    missingInfo: missingInfo.length > 0 ? missingInfo : ['All required information collected'],
    
    // Context
    conversationState,
    lastBotQuestion,
    lastExpectedField,
    
    // Recent flow
    recentTurns: recentTurns.slice(-2), // Only last 2 turns for immediate context
    
    // Metadata
    totalTurns: Math.floor(messages.length / 2),
    submissionDeclined: sessionState.submissionDeclined || false,
    submissionApproved: sessionState.submissionApproved || false
  };
};

/**
 * Summarize conversation history using LLM
 * Called every N turns to compress history
 * 
 * @param {Array} messages - Full message history
 * @param {Object} currentSummary - Current conversation summary
 * @returns {Promise<string>} Summarized conversation
 */
export const summarizeConversation = async (messages, currentSummary) => {
  if (!openai) {
    // Fallback: return basic summary
    return `Conversation summary: ${currentSummary.confirmedInfo.join(', ')}. Missing: ${currentSummary.missingInfo.join(', ')}.`;
  }

  // Get last N messages to summarize
  const messagesToSummarize = messages.slice(-SUMMARIZATION_INTERVAL * 2);
  
  const conversationText = messagesToSummarize.map(msg => {
    const role = msg.sender === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.message}`;
  }).join('\n');

  const systemPrompt = `You are a conversation summarizer. Create a concise summary of this conversation that captures:
1. What the problem is
2. What information has been confirmed/collected
3. What information is still missing
4. The user's last intent or action
5. Any important context or clarifications

Current summary state:
${currentSummary.confirmedInfo.length > 0 ? `Confirmed: ${currentSummary.confirmedInfo.join(', ')}` : 'Nothing confirmed yet'}
${currentSummary.missingInfo.length > 0 ? `Missing: ${currentSummary.missingInfo.join(', ')}` : 'All information collected'}

Recent conversation:
${conversationText}

Create a concise summary (2-3 sentences) that captures the key points. Focus on what's been established and what's still needed.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Summarize this conversation.' }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    const summary = completion.choices[0]?.message?.content?.trim();
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Memory] Summarized conversation');
    }
    
    return summary || 'No summary available';
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Conversation Memory] Summarization error:', error.message);
    }
    // Fallback
    return `Conversation: ${currentSummary.confirmedInfo.join(', ')}. Missing: ${currentSummary.missingInfo.join(', ')}.`;
  }
};

/**
 * Check if conversation should be summarized
 * Summarize every N turns
 */
export const shouldSummarize = (sessionState) => {
  const messageCount = sessionState.messages?.length || 0;
  const turns = Math.floor(messageCount / 2);
  
  // Summarize every N turns, but not on first turn
  return turns > 0 && turns % SUMMARIZATION_INTERVAL === 0;
};

/**
 * Get conversation context for LLM
 * Returns either summary or recent messages based on length
 */
export const getConversationContext = (sessionState) => {
  const summary = buildConversationSummary(sessionState);
  const messages = sessionState.messages || [];
  
  // If we have a stored summary and many messages, use summary
  if (sessionState.conversationSummary && messages.length > SUMMARIZATION_INTERVAL * 2) {
    return {
      type: 'summary',
      content: sessionState.conversationSummary,
      summary: summary,
      recentMessages: messages.slice(-4) // Last 2 turns for immediate context
    };
  }
  
  // Otherwise use recent messages
  return {
    type: 'messages',
    content: messages.slice(-SUMMARIZATION_INTERVAL * 2),
    summary: summary
  };
};

/**
 * Update conversation summary in session state
 */
export const updateConversationSummary = async (sessionState) => {
  if (shouldSummarize(sessionState)) {
    const currentSummary = buildConversationSummary(sessionState);
    const newSummary = await summarizeConversation(sessionState.messages || [], currentSummary);
    
    return {
      ...sessionState,
      conversationSummary: newSummary,
      lastSummarizedAt: new Date().toISOString()
    };
  }
  
  return sessionState;
};

export default {
  buildConversationSummary,
  summarizeConversation,
  shouldSummarize,
  getConversationContext,
  updateConversationSummary
};

