/**
 * SMART PROBING SERVICE
 * 
 * Context-aware question generation for collecting missing information.
 * 
 * Rules:
 * - Ask max 1-2 questions per turn
 * - Skip questions already answered implicitly
 * - Acknowledge user input before probing
 * - Dynamic follow-ups based on what user said
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildConversationSummary } from './conversationMemoryService.js';

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
 * Generate smart probing questions
 * 
 * @param {Object} sessionState - Current session state
 * @param {Array} missingFields - Fields that are still missing
 * @param {string} lastUserMessage - Last message from user
 * @param {string} acknowledgment - Acknowledgment message (if any)
 * @returns {Promise<string>} Natural question to ask
 */
export const generateProbingQuestion = async (sessionState, missingFields, lastUserMessage = '', acknowledgment = '') => {
  if (!openai) {
    return generateProbingQuestionFallback(missingFields);
  }

  const summary = buildConversationSummary(sessionState);
  const { conversationState, lastBotQuestion, lastExpectedField } = sessionState;

  // Determine priority fields (what to ask about next)
  const priorityFields = determinePriority(missingFields, sessionState);

  const systemPrompt = `You are a support chatbot asking questions to collect information. Your job is to generate natural, conversational questions.

CURRENT STATE: ${conversationState}

WHAT WE KNOW:
${summary.confirmedInfo.join('\n')}

WHAT WE STILL NEED:
${summary.missingInfo.join('\n')}

${lastBotQuestion ? `LAST QUESTION ASKED: "${lastBotQuestion}"` : ''}
${lastUserMessage ? `USER'S LAST MESSAGE: "${lastUserMessage}"` : ''}

${acknowledgment ? `ACKNOWLEDGMENT TO INCLUDE: "${acknowledgment}"` : ''}

PRIORITY: Ask about ${priorityFields.join(' or ')}

Generate a natural, conversational question that:
1. Acknowledges what the user just said (if acknowledgment is provided)
2. Asks about ONE missing field (the highest priority)
3. Is conversational and human-like, not robotic
4. Never repeats the exact same question you asked before
5. Varies your phrasing slightly

Examples:
- Instead of "What is the urgency?", say "How urgent is this issue? Is it blocking your work, or do you have a workaround?"
- Instead of "What is the category?", say "What type of issue is this? Is it related to hardware, software, network, or something else?"
- Instead of "What is the affected system?", say "Which system or application is affected? For example, Outlook, Windows, or the network?"

Respond with ONLY the question text. No JSON, no explanation, just the natural question.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate a natural question to ask about the missing information.' }
      ],
      temperature: 0.7, // Higher temperature for natural variation
      max_tokens: 150
    });

    const question = completion.choices[0]?.message?.content?.trim();
    
    if (!question) {
      return generateProbingQuestionFallback(missingFields);
    }

    // Clean up question (remove quotes if present)
    const cleanQuestion = question.replace(/^["']|["']$/g, '');

    if (ENABLE_LOGGING) {
      console.log('[Smart Probing] Generated question:', cleanQuestion);
    }

    return cleanQuestion;
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Smart Probing] Error:', error.message);
    }
    return generateProbingQuestionFallback(missingFields);
  }
};

/**
 * Determine priority of missing fields
 * Returns ordered list of fields to ask about
 */
const determinePriority = (missingFields, sessionState) => {
  const intake = sessionState.intake || {};
  
  // Priority order:
  // 1. problem (always first if missing)
  // 2. category (helps determine other requirements)
  // 3. urgency (important for prioritization)
  // 4. affectedSystem (specific detail)
  // 5. errorText (last, can be "no error provided")
  
  const priority = [];
  
  if (missingFields.includes('problem')) {
    priority.push('problem');
  }
  if (missingFields.includes('category')) {
    priority.push('category');
  }
  if (missingFields.includes('urgency')) {
    priority.push('urgency');
  }
  if (missingFields.includes('affectedSystem')) {
    priority.push('affectedSystem');
  }
  if (missingFields.includes('errorText')) {
    priority.push('errorText');
  }
  
  // Return first 2 priorities (max 2 questions per turn)
  return priority.slice(0, 2);
};

/**
 * Fallback question generation
 */
const generateProbingQuestionFallback = (missingFields) => {
  if (missingFields.length === 0) {
    return null;
  }

  const field = missingFields[0];
  const questions = {
    problem: "Could you describe the issue you're experiencing?",
    category: "What type of issue is this? (hardware, software, network, email, password, or other)",
    urgency: "How urgent is this? Is it blocking your work, or do you have a workaround?",
    affectedSystem: "Which system or application is affected?",
    errorText: "Are you seeing any error messages? If not, that's fine - just let me know."
  };

  return questions[field] || "Could you provide more details?";
};

/**
 * Check if a question was already asked
 */
export const wasQuestionAsked = (sessionState, field) => {
  const askedQuestions = sessionState.askedQuestions || [];
  const lastBotQuestion = sessionState.lastBotQuestion || '';
  
  // Check if field was asked about in last question
  const fieldKeywords = {
    problem: ['issue', 'problem', 'describe', 'what'],
    category: ['category', 'type', 'kind'],
    urgency: ['urgent', 'urgency', 'priority', 'blocking'],
    affectedSystem: ['system', 'application', 'app', 'which'],
    errorText: ['error', 'message', 'error message']
  };
  
  const keywords = fieldKeywords[field] || [];
  const lastQuestionLower = lastBotQuestion.toLowerCase();
  
  return keywords.some(keyword => lastQuestionLower.includes(keyword));
};

export default {
  generateProbingQuestion,
  wasQuestionAsked
};

