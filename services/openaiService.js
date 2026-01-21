import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TEST_MODE = process.env.TEST_MODE === 'true';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
} else {
  console.warn('OPENAI_API_KEY not configured. AI features will be disabled.');
}

/**
 * Build conversation context string from recent messages
 */
const buildConversationContext = (messages = [], maxPairs = 5) => {
  if (!messages || messages.length === 0) {
    return '';
  }
  
  // Get last N message pairs (user + system)
  const recentMessages = messages.slice(-maxPairs * 2);
  const contextPairs = [];
  
  for (let i = 0; i < recentMessages.length - 1; i++) {
    const userMsg = recentMessages[i];
    const systemMsg = recentMessages[i + 1];
    
    if (userMsg.sender === 'user' && systemMsg.sender === 'system') {
      contextPairs.push({
        user: userMsg.message,
        assistant: systemMsg.message
      });
      i++; // Skip next message as we've paired it
    }
  }
  
  if (contextPairs.length === 0) {
    return '';
  }
  
  return contextPairs.map((pair, idx) => 
    `Turn ${idx + 1}:\nUser: ${pair.user}\nAssistant: ${pair.assistant}`
  ).join('\n\n');
};

/**
 * Build category-specific rules for prompt
 */
const buildCategoryRules = (category) => {
  if (!category) {
    return '';
  }
  
  const rules = {
    password: `Category: Password Reset
Required fields: issue, urgency, errorText
Optional fields: affectedSystem (not needed for password issues)
Do NOT ask for affectedSystem unless user mentions a specific system.`,
    hardware: `Category: Hardware Issue
Required fields: issue, category, urgency, affectedSystem, errorText
All fields are required.`,
    software: `Category: Software Issue
Required fields: issue, category, urgency, affectedSystem, errorText
All fields are required.`,
    network: `Category: Network Issue
Required fields: issue, category, urgency, affectedSystem, errorText
All fields are required.`,
    email: `Category: Email Issue
Required fields: issue, category, urgency, affectedSystem, errorText
All fields are required.`,
    other: `Category: Other
Required fields: issue, category, urgency, affectedSystem, errorText
All fields are required.`
  };
  
  return rules[category] || '';
};

/**
 * Build strict intake system prompt with conversation context and category awareness
 */
const buildSystemPrompt = (collectedFields, missingFields, askedQuestions, category = null, conversationContext = '') => {
  const collectedList = collectedFields.length > 0 
    ? `\n\nFields already collected:\n${collectedFields.map(f => `- ${f}`).join('\n')}`
    : '\n\nNo fields have been collected yet.';
  
  const missingList = missingFields.length > 0
    ? `\n\nFields still missing:\n${missingFields.map(f => `- ${f}`).join('\n')}`
    : '\n\nAll required fields have been collected.';
  
  const askedList = askedQuestions.length > 0
    ? `\n\nQuestions already asked (DO NOT REPEAT):\n${askedQuestions.map(q => `- "${q}"`).join('\n')}`
    : '\n\nNo questions have been asked yet.';
  
  const categoryRules = category ? `\n\n${buildCategoryRules(category)}` : '';
  const contextSection = conversationContext ? `\n\nConversation context (recent exchanges):\n${conversationContext}` : '';

  return `You are an IT support intake assistant.

You are given:
- The current intake state
- Fields already collected
- Fields still missing
- Conversation context (recent message exchanges)
${askedList}${categoryRules}${contextSection}

Rules:
- NEVER ask about information already collected
- NEVER repeat a question (check the asked questions list above)
- Extract information from the user's message and fill ONLY missing fields
- If a field is already collected, set it to null in extracted (do not overwrite)
- Use conversation context to understand user intent and avoid asking redundant questions
- Be conversational and natural, not form-like

Current state:${collectedList}${missingList}

You must respond in VALID JSON ONLY with this exact format:
{
  "extracted": {
    "issue": null,
    "category": null,
    "urgency": null,
    "affectedSystem": null,
    "errorText": null
  },
  "suggestedQuestion": null,
  "confidence": "high|medium|low"
}

Rules for extracted fields:
- Only fill fields that are MISSING (currently null in intake state)
- Set fields that are already collected to null
- category: "password" | "hardware" | "software" | "network" | "email" | "other" | null
- urgency: "blocked" | "high" | "medium" | "low" | null
- errorText can be "no error provided" if user says there's no error

Rules for suggestedQuestion:
- This is a SUGGESTION only - backend will decide the final question
- Suggest a question about ONE missing field only
- Do NOT repeat any question from the asked questions list
- Be concise, conversational, and professional
- Set to null if you cannot suggest a good question
- Example: "What is the urgency level? (blocked, high, medium, or low)"

Rules for confidence:
- "high": You extracted clear information or can suggest a good question
- "medium": Some information extracted but unclear, or question suggestion is tentative
- "low": Little to no information extracted, or cannot suggest a good question`;
};

/**
 * Validate OpenAI response JSON structure
 */
const validateAIResponse = (response) => {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }

  const requiredFields = ['extracted', 'suggestedQuestion', 'confidence'];
  for (const field of requiredFields) {
    if (!(field in response)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  if (response.suggestedQuestion !== null && typeof response.suggestedQuestion !== 'string') {
    return { valid: false, error: 'suggestedQuestion must be a string or null' };
  }

  const validConfidences = ['high', 'medium', 'low'];
  if (!validConfidences.includes(response.confidence)) {
    return { valid: false, error: `Invalid confidence: ${response.confidence}. Must be one of: ${validConfidences.join(', ')}` };
  }

  if (!response.extracted || typeof response.extracted !== 'object') {
    return { valid: false, error: 'extracted must be an object' };
  }

  const validCategories = ['password', 'hardware', 'software', 'network', 'email', 'other', null];
  if (response.extracted.category !== null && !validCategories.includes(response.extracted.category)) {
    return { valid: false, error: `Invalid category: ${response.extracted.category}` };
  }

  const validUrgencies = ['blocked', 'high', 'medium', 'low', null];
  if (response.extracted.urgency !== null && !validUrgencies.includes(response.extracted.urgency)) {
    return { valid: false, error: `Invalid urgency: ${response.extracted.urgency}` };
  }

  return { valid: true };
};

/**
 * Process user message with OpenAI (state-driven with conversation context)
 * @param {string} userMessage - The user's message
 * @param {Object} sessionState - Current session state with intake, askedQuestions, messages
 * @param {string[]} missingFields - Fields that are still missing
 * @param {string} intent - User intent classification
 * @returns {Promise<Object>} AI response with extracted data and suggested question
 */
export const processUserMessage = async (userMessage, sessionState, missingFields, intent = null) => {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    throw new Error('Invalid user message');
  }

  const intake = sessionState.intake || {};
  const askedQuestions = sessionState.askedQuestions || [];
  const messages = sessionState.messages || [];
  const category = intake.category || null;

  // Build collected fields list
  const collectedFields = [];
  if (intake.issue) collectedFields.push('issue');
  if (intake.category) collectedFields.push('category');
  if (intake.urgency) collectedFields.push('urgency');
  if (intake.affectedSystem) collectedFields.push('affectedSystem');
  if (intake.errorText !== null && intake.errorText !== undefined) collectedFields.push('errorText');

  // Build conversation context (last 3-5 message pairs)
  const conversationContext = buildConversationContext(messages, 5);

  // Build system prompt with current state, category rules, and conversation context
  const systemPrompt = buildSystemPrompt(collectedFields, missingFields, askedQuestions, category, conversationContext);

  // Build user message with intent context
  const intentContext = intent ? `\n\nUser intent: ${intent}` : '';
  const userPrompt = `User message: "${userMessage}"${intentContext}

Extract information from this message and fill only the missing fields. Do not overwrite existing data.`;

  const startTime = Date.now();

  try {
    if (ENABLE_LOGGING) {
      console.log('[OpenAI] Processing message:', {
        messageLength: userMessage.length,
        sessionId: sessionState.sessionId,
        missingFields: missingFields.length,
        collectedFields: collectedFields.length,
        category: category || 'none',
        intent: intent || 'none',
        conversationTurns: Math.floor((messages.length || 0) / 2)
      });
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4, // Slightly higher for more natural responses, but still controlled
      max_tokens: 300,
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
        console.error('[OpenAI] JSON parse error:', parseError.message);
        console.error('[OpenAI] Raw response:', content);
      }
      throw new Error(`Invalid JSON response from OpenAI: ${parseError.message}`);
    }

    // Validate response structure
    const validation = validateAIResponse(parsedResponse);
    if (!validation.valid) {
      if (ENABLE_LOGGING) {
        console.error('[OpenAI] Validation error:', validation.error);
        console.error('[OpenAI] Response:', parsedResponse);
      }
      throw new Error(`Invalid response structure: ${validation.error}`);
    }

    if (ENABLE_LOGGING) {
      console.log('[OpenAI] Success:', {
        confidence: parsedResponse.confidence,
        hasSuggestedQuestion: !!parsedResponse.suggestedQuestion,
        extractedFields: Object.values(parsedResponse.extracted).filter(v => v !== null).length,
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
      console.error('[OpenAI] Error:', error.message);
    }
    throw error;
  }
};

/**
 * Generate ticket summary using OpenAI
 * @param {Object} intake - Complete intake data
 * @param {Object} userContext - User context
 * @returns {Promise<Object>} Summary object with summary and keyDetails
 */
export const generateTicketSummary = async (intake, userContext) => {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  const prompt = `Generate a professional IT support ticket summary.

Customer: ${userContext.fullName || 'Unknown'}
Company: ${userContext.company || 'Not provided'}

Issue Details:
- Issue: ${intake.issue || 'Not provided'}
- Category: ${intake.category || 'Not specified'}
- Urgency: ${intake.urgency || 'Not specified'}
- Affected System: ${intake.affectedSystem || 'Not specified'}
- Error Text: ${intake.errorText || 'No error provided'}

Return JSON with:
- summary: A concise 1-3 sentence summary of the issue
- keyDetails: Array of 3-5 bullet point strings with the most important details

Example format:
{
  "summary": "User experiencing login issues with email system. Issue is blocking work and affects Outlook application.",
  "keyDetails": [
    "Cannot log into email account",
    "Affecting Outlook application",
    "Issue is blocking work",
    "No error message provided"
  ]
}`;

  try {
    if (ENABLE_LOGGING) {
      console.log('[OpenAI] Generating ticket summary');
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a professional IT support ticket writer. Generate clear, concise summaries.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 300,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);
    
    if (!parsed.summary || typeof parsed.summary !== 'string') {
      throw new Error('Invalid summary in response');
    }

    if (!Array.isArray(parsed.keyDetails)) {
      throw new Error('Invalid keyDetails in response');
    }

    return {
      summary: parsed.summary,
      keyDetails: parsed.keyDetails.filter(detail => typeof detail === 'string')
    };
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[OpenAI] Summary generation error:', error.message);
    }
    throw error;
  }
};

/**
 * Check if OpenAI is available
 */
export const isOpenAIAvailable = () => {
  return openai !== null;
};

export default {
  processUserMessage,
  generateTicketSummary,
  isOpenAIAvailable
};
