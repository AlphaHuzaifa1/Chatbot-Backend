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
    conversationSummary = '',
    lastExpectedField = null
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

  // Intent-aware extraction: prioritize fields the user is currently answering
  const expectedFields = lastExpectedField ? [lastExpectedField] : fieldsToExtract;
  const expectedFieldsList = expectedFields.length > 0 
    ? `PRIORITY FIELDS TO EXTRACT (user is likely answering these): ${expectedFields.join(', ')}`
    : '';
  
  const systemPrompt = `You are a semantic field extractor for a support chatbot. Your job is to extract structured information from user messages using SEMANTIC UNDERSTANDING, not keywords.

${conversationSummary ? `CONVERSATION CONTEXT:\n${conversationSummary}\n` : ''}

${lastBotQuestion ? `LAST QUESTION ASKED: "${lastBotQuestion}"\n` : ''}

${lastExpectedField ? `EXPECTED FIELD (user is likely answering this): "${lastExpectedField}"\n` : ''}

${expectedFieldsList ? `${expectedFieldsList}\n` : ''}

WHAT WE ALREADY KNOW:
${knownFields.length > 0 ? knownFields.join('\n') : 'Nothing yet'}

USER MESSAGE: "${userMessage}"

Extract ONLY the fields that are clearly present in the message. Use semantic understanding:
- problem: What technical issue is the user experiencing? Extract the full description.
- category: One of: "password", "hardware", "software", "network", "email", "other". Infer from context.
- urgency: One of: "blocked" (work completely blocked), "high" (urgent but workaround exists), "medium" (moderate impact), "low" (minor inconvenience). Infer from language.
- affectedSystem: The specific application, system, or service affected (e.g., "Outlook", "Windows", "Network", "Email").
- errorText: Any error messages mentioned, or "no error provided" if user explicitly says there's no error.
- passwordContext: (For password category only) One of: "desktop login", "email", "specific application". What password is this for?
- deviceType: (For hardware category only) One of: "laptop", "desktop". What type of device?
- powerSymptoms: (For hardware category only) One of: "no lights", "lights on", "fan noise", "screen blank". What happens when powering on?
- impact: (For hardware category only) One of: "blocked" (completely blocked), "degraded" (can still work but slower/limited). How is work affected?
- scope: (For hardware category only) One of: "single user", "multiple users". Who is affected?

RULES:
1. Only extract fields that are CLEARLY present in the message
2. PRIORITIZE extracting the expected field(s) if the user is answering a specific question
3. Do NOT extract fields that are NOT mentioned in the message (set to null)
4. Use semantic understanding - "I can't work" = blocked urgency, "Outlook is down" = email category
5. Set confidence based on how clear the information is (0.0-1.0)
6. If information is ambiguous or inferred, set lower confidence
7. If user says "no error" or "no error message", set errorText to "no error provided"
8. If lastExpectedField is set, focus on extracting that field primarily, but still extract other clearly present fields

Respond with JSON:
{
  "extracted": {
    "problem": { "value": "string or null", "confidence": 0.0-1.0 },
    "category": { "value": "string or null", "confidence": 0.0-1.0 },
    "urgency": { "value": "string or null", "confidence": 0.0-1.0 },
    "affectedSystem": { "value": "string or null", "confidence": 0.0-1.0 },
    "errorText": { "value": "string or null", "confidence": 0.0-1.0 },
    "passwordContext": { "value": "string or null", "confidence": 0.0-1.0 },
    "deviceType": { "value": "string or null", "confidence": 0.0-1.0 },
    "powerSymptoms": { "value": "string or null", "confidence": 0.0-1.0 },
    "impact": { "value": "string or null", "confidence": 0.0-1.0 },
    "scope": { "value": "string or null", "confidence": 0.0-1.0 }
  }
}

IMPORTANT:
- Only include fields that are actually in the message
- Set value to null if field is not present
- Confidence should reflect how certain you are (high = clear, low = inferred/ambiguous)
- If lastExpectedField is provided, prioritize extracting that field but don't force it if not present`;

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

    const validFields = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText', 'passwordContext', 'deviceType', 'powerSymptoms', 'impact', 'scope'];
    const validCategories = ['password', 'hardware', 'software', 'network', 'email', 'other'];
    const validUrgencies = ['blocked', 'high', 'medium', 'low'];
    const validPasswordContexts = ['desktop login', 'email', 'specific application'];
    const validDeviceTypes = ['laptop', 'desktop'];
    const validPowerSymptoms = ['no lights', 'lights on', 'fan noise', 'screen blank'];
    const validImpacts = ['blocked', 'degraded'];
    const validScopes = ['single user', 'multiple users'];

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
        // Validate passwordContext
        else if (field === 'passwordContext') {
          const contextValue = fieldData.value.toLowerCase();
          // Normalize variations
          let normalized = contextValue;
          if (contextValue.includes('desktop') || contextValue.includes('computer') || contextValue.includes('login')) {
            normalized = 'desktop login';
          } else if (contextValue.includes('email') || contextValue.includes('mail')) {
            normalized = 'email';
          } else if (contextValue.includes('application') || contextValue.includes('app')) {
            normalized = 'specific application';
          }
          if (validPasswordContexts.includes(normalized)) {
            extracted[field] = normalized;
          } else {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid passwordContext: ${fieldData.value}`);
            }
            continue;
          }
        }
        // Validate deviceType
        else if (field === 'deviceType') {
          const deviceValue = fieldData.value.toLowerCase();
          if (validDeviceTypes.includes(deviceValue)) {
            extracted[field] = deviceValue;
          } else {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid deviceType: ${fieldData.value}`);
            }
            continue;
          }
        }
        // Validate powerSymptoms
        else if (field === 'powerSymptoms') {
          const symptomsValue = fieldData.value.toLowerCase();
          // Normalize variations
          let normalized = symptomsValue;
          if (symptomsValue.includes('no light') || symptomsValue.includes('no power')) {
            normalized = 'no lights';
          } else if (symptomsValue.includes('light') && !symptomsValue.includes('no')) {
            normalized = 'lights on';
          } else if (symptomsValue.includes('fan')) {
            normalized = 'fan noise';
          } else if (symptomsValue.includes('blank') || symptomsValue.includes('black screen')) {
            normalized = 'screen blank';
          }
          if (validPowerSymptoms.includes(normalized)) {
            extracted[field] = normalized;
          } else {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid powerSymptoms: ${fieldData.value}`);
            }
            continue;
          }
        }
        // Validate impact
        else if (field === 'impact') {
          const impactValue = fieldData.value.toLowerCase();
          if (validImpacts.includes(impactValue)) {
            extracted[field] = impactValue;
          } else {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid impact: ${fieldData.value}`);
            }
            continue;
          }
        }
        // Validate scope
        else if (field === 'scope') {
          const scopeValue = fieldData.value.toLowerCase();
          // Normalize variations
          let normalized = scopeValue;
          if (scopeValue.includes('multiple') || scopeValue.includes('others') || scopeValue.includes('team')) {
            normalized = 'multiple users';
          } else if (scopeValue.includes('single') || scopeValue.includes('just me') || scopeValue.includes('only me')) {
            normalized = 'single user';
          }
          if (validScopes.includes(normalized)) {
            extracted[field] = normalized;
          } else {
            if (ENABLE_LOGGING) {
              console.warn(`[Semantic Extraction] Invalid scope: ${fieldData.value}`);
            }
            continue;
          }
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

