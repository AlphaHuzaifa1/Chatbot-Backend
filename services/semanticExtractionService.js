/**
 * SEMANTIC EXTRACTION SERVICE
 * 
 * Extracts structured fields from user messages using semantic understanding.
 * NO keyword matching - pure semantic interpretation.
 * 
 * The LLM is used as a semantic interpreter, not a decision-maker.
 * It extracts what it can understand from the message.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const FIELD_CONFIDENCE_THRESHOLD = parseFloat(process.env.FIELD_CONFIDENCE_THRESHOLD || '0.6');

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
}

/**
 * Extract fields from user message using semantic understanding
 * 
 * @param {string} userMessage - User's message
 * @param {Object} context - Extraction context
 * @param {Object} context.currentIntake - Current intake fields (to avoid overwriting)
 * @param {Array} context.fieldsToExtract - Fields to try extracting (from brain decision)
 * @param {string} context.lastBotQuestion - Last question asked
 * @param {string} context.conversationSummary - Conversation summary
 * @returns {Promise<Object>} Extracted fields with confidence scores
 */
export const extractFields = async (userMessage, context = {}) => {
  if (!openai) {
    // Fallback: return empty extraction
    return {
      extracted: {},
      confidence: {}
    };
  }

  const {
    currentIntake = {},
    fieldsToExtract = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'],
    lastBotQuestion = '',
    conversationSummary = ''
  } = context;

  // Build what we already know
  const knownFields = [];
  if (currentIntake.problem) knownFields.push(`Problem: ${currentIntake.problem}`);
  if (currentIntake.category) knownFields.push(`Category: ${currentIntake.category}`);
  if (currentIntake.urgency) knownFields.push(`Urgency: ${currentIntake.urgency}`);
  if (currentIntake.affectedSystem) knownFields.push(`Affected System: ${currentIntake.affectedSystem}`);
  if (currentIntake.errorText !== null && currentIntake.errorText !== undefined) {
    knownFields.push(`Error Text: ${currentIntake.errorText}`);
  }

  const systemPrompt = `You are a semantic field extractor for a support chatbot. Your job is to extract structured information from user messages using SEMANTIC UNDERSTANDING, not keywords.

${conversationSummary ? `CONVERSATION CONTEXT:\n${conversationSummary}\n` : ''}

${lastBotQuestion ? `LAST QUESTION ASKED: "${lastBotQuestion}"\n` : ''}

WHAT WE ALREADY KNOW:
${knownFields.length > 0 ? knownFields.join('\n') : 'Nothing yet'}

USER MESSAGE: "${userMessage}"

Extract ONLY the fields that are clearly present in the message. Use semantic understanding:
- problem: What technical issue is the user experiencing? Extract the full description.
- category: One of: "password", "hardware", "software", "network", "email", "other". Infer from context.
- urgency: One of: "blocked" (work completely blocked), "high" (urgent but workaround exists), "medium" (moderate impact), "low" (minor inconvenience). Infer from language.
- affectedSystem: The specific application, system, or service affected (e.g., "Outlook", "Windows", "Network", "Email").
- errorText: Any error messages mentioned, or "no error provided" if user explicitly says there's no error.

RULES:
1. Only extract fields that are CLEARLY present in the message
2. Do NOT overwrite existing fields (only extract missing ones)
3. Use semantic understanding - "I can't work" = blocked urgency, "Outlook is down" = email category
4. Set confidence based on how clear the information is (0.0-1.0)
5. If information is ambiguous, set lower confidence
6. If user says "no error" or "no error message", set errorText to "no error provided"

Respond with JSON:
{
  "extracted": {
    "problem": { "value": "string or null", "confidence": 0.0-1.0 },
    "category": { "value": "string or null", "confidence": 0.0-1.0 },
    "urgency": { "value": "string or null", "confidence": 0.0-1.0 },
    "affectedSystem": { "value": "string or null", "confidence": 0.0-1.0 },
    "errorText": { "value": "string or null", "confidence": 0.0-1.0 }
  }
}

IMPORTANT:
- Only include fields that are actually in the message
- Set value to null if field is not present
- Confidence should reflect how certain you are (high = clear, low = inferred/ambiguous)`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Extract fields from: "${userMessage}"` }
      ],
      temperature: 0.2, // Low temperature for consistent extraction
      max_tokens: 400,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from field extractor');
    }

    const result = JSON.parse(content);

    // Validate and normalize extracted fields
    const extracted = {};
    const confidence = {};

    const validFields = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];
    const validCategories = ['password', 'hardware', 'software', 'network', 'email', 'other'];
    const validUrgencies = ['blocked', 'high', 'medium', 'low'];

    for (const field of validFields) {
      const fieldData = result.extracted?.[field];
      
      if (fieldData && fieldData.value !== null && fieldData.value !== undefined && fieldData.value !== '') {
        // Validate category
        if (field === 'category') {
          const categoryValue = fieldData.value.toLowerCase();
          if (!validCategories.includes(categoryValue)) {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid category: ${fieldData.value}`);
            }
            continue; // Skip invalid category
          }
          extracted[field] = categoryValue;
        }
        // Validate urgency
        else if (field === 'urgency') {
          const urgencyValue = fieldData.value.toLowerCase();
          if (!validUrgencies.includes(urgencyValue)) {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid urgency: ${fieldData.value}`);
            }
            continue; // Skip invalid urgency
          }
          extracted[field] = urgencyValue;
        }
        // Other fields
        else {
          extracted[field] = fieldData.value;
        }
        
        // Set confidence
        const conf = typeof fieldData.confidence === 'number' 
          ? Math.max(0, Math.min(1, fieldData.confidence))
          : 0.5;
        confidence[field] = conf;
      }
    }

    if (ENABLE_LOGGING) {
      console.log('[Semantic Extraction] Extracted:', {
        fields: Object.keys(extracted),
        confidence: confidence
      });
    }

    return {
      extracted,
      confidence
    };
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Semantic Extraction] Error:', error.message);
    }
    return {
      extracted: {},
      confidence: {}
    };
  }
};

/**
 * Filter extracted fields by confidence threshold
 */
export const filterByConfidence = (extracted, confidence, threshold = FIELD_CONFIDENCE_THRESHOLD) => {
  const filtered = {};
  const filteredConfidence = {};

  for (const [field, value] of Object.entries(extracted)) {
    const conf = confidence[field] || 0;
    if (conf >= threshold) {
      filtered[field] = value;
      filteredConfidence[field] = conf;
    }
  }

  return {
    extracted: filtered,
    confidence: filteredConfidence
  };
};

export default {
  extractFields,
  filterByConfidence
};

