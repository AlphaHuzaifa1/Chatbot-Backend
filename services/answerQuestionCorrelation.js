/**
 * Answer-Question Correlation Service
 * Validates if a user's message actually answers the last question asked
 * Prevents extraction from off-topic or irrelevant messages
 */

const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

/**
 * Field keywords mapping - helps identify which field a question is about
 */
const FIELD_KEYWORDS = {
  issue: ['issue', 'problem', 'what', 'describe', 'happening', 'wrong', 'trouble'],
  category: ['category', 'type', 'kind', 'which category', 'what type'],
  urgency: ['urgency', 'urgent', 'priority', 'how urgent', 'how quickly', 'severity'],
  affectedSystem: ['system', 'application', 'app', 'which system', 'what system', 'device', 'software'],
  errorText: ['error', 'error message', 'error text', 'what error', 'error code', 'message']
};

/**
 * Check if a question is about a specific field
 * @param {string} question - The question text
 * @param {string} field - Field name to check
 * @returns {boolean} True if question is about this field
 */
export const isQuestionAboutField = (question, field) => {
  if (!question || !field) return false;
  
  const questionLower = question.toLowerCase();
  const keywords = FIELD_KEYWORDS[field] || [];
  
  return keywords.some(keyword => questionLower.includes(keyword));
};

/**
 * Validate if user message answers the last question
 * Uses keyword matching and semantic analysis
 * @param {string} userMessage - User's message
 * @param {string} lastQuestion - Last question asked by bot
 * @param {string} lastExpectedField - Field the bot was asking about
 * @param {string} intent - Classified intent
 * @returns {Object} { isAnswer: boolean, confidence: 'high'|'medium'|'low', reason: string }
 */
export const validateAnswerToQuestion = (userMessage, lastQuestion, lastExpectedField, intent) => {
  // If no last question, can't validate
  if (!lastQuestion) {
    return {
      isAnswer: true, // Assume it's an answer if no question context
      confidence: 'low',
      reason: 'No previous question to validate against'
    };
  }

  // Off-topic or security risk intents are definitely NOT answers
  if (intent === 'OFF_TOPIC' || intent === 'SECURITY_RISK') {
    return {
      isAnswer: false,
      confidence: 'high',
      reason: `Intent is ${intent}, not an answer`
    };
  }

  // Confirmation, cancel, submit are not answers to intake questions
  if (['CONFIRMATION', 'CANCEL', 'SUBMIT_REQUEST'].includes(intent)) {
    return {
      isAnswer: false,
      confidence: 'high',
      reason: `Intent is ${intent}, not an answer to intake question`
    };
  }

  // Clarification and confused are not answers
  if (['CLARIFICATION', 'CONFUSED'].includes(intent)) {
    return {
      isAnswer: false,
      confidence: 'high',
      reason: `Intent is ${intent}, user is asking for help, not answering`
    };
  }

  // If we know the expected field, validate against it
  if (lastExpectedField) {
    const questionIsAboutField = isQuestionAboutField(lastQuestion, lastExpectedField);
    
    if (questionIsAboutField) {
      // Check if user message contains keywords related to the expected field
      const userLower = userMessage.toLowerCase();
      const fieldKeywords = FIELD_KEYWORDS[lastExpectedField] || [];
      
      // If user message contains field-specific keywords, likely an answer
      const hasFieldKeywords = fieldKeywords.some(kw => userLower.includes(kw));
      
      // For urgency and category, check for expected values
      if (lastExpectedField === 'urgency') {
        const urgencyValues = ['blocked', 'critical', 'high', 'medium', 'low', 'urgent'];
        const hasUrgencyValue = urgencyValues.some(val => userLower.includes(val));
        if (hasUrgencyValue) {
          return {
            isAnswer: true,
            confidence: 'high',
            reason: 'Contains urgency level value'
          };
        }
      }
      
      if (lastExpectedField === 'category') {
        const categoryValues = ['password', 'hardware', 'software', 'network', 'email', 'other'];
        const hasCategoryValue = categoryValues.some(val => userLower.includes(val));
        if (hasCategoryValue) {
          return {
            isAnswer: true,
            confidence: 'high',
            reason: 'Contains category value'
          };
        }
      }
      
      // If message is very short and contains field keywords, likely an answer
      if (userMessage.length <= 30 && hasFieldKeywords) {
        return {
          isAnswer: true,
          confidence: 'medium',
          reason: 'Short message with field keywords'
        };
      }
      
      // If message is substantial and intent is PROVIDE_INFO or ANSWER, likely an answer
      if (userMessage.length > 10 && ['PROVIDE_INFO', 'ANSWER'].includes(intent)) {
        return {
          isAnswer: true,
          confidence: 'medium',
          reason: `Substantial message with ${intent} intent`
        };
      }
    }
  }

  // Default: if intent suggests providing info and message is substantial, treat as answer
  if (['PROVIDE_INFO', 'ANSWER'].includes(intent) && userMessage.length > 5) {
    return {
      isAnswer: true,
      confidence: 'medium',
      reason: `Intent ${intent} with substantial message`
    };
  }

  // If intent is CORRECT_PREVIOUS, it's an answer (user correcting)
  if (intent === 'CORRECT_PREVIOUS') {
    return {
      isAnswer: true,
      confidence: 'high',
      reason: 'User correcting previous answer'
    };
  }

  // Default: uncertain
  return {
    isAnswer: true, // Default to true to avoid blocking legitimate answers
    confidence: 'low',
    reason: 'Unable to definitively validate, defaulting to allow'
  };
};

/**
 * Extract which field(s) a user message is likely answering
 * Used for multi-field extraction strategy
 * @param {string} userMessage - User's message
 * @param {Array} missingFields - Fields that are still missing
 * @returns {Array} Array of field names the message likely answers
 */
export const identifyAnsweredFields = (userMessage, missingFields) => {
  const userLower = userMessage.toLowerCase();
  const answeredFields = [];

  // Check each missing field
  for (const field of missingFields) {
    const keywords = FIELD_KEYWORDS[field] || [];
    const hasKeywords = keywords.some(kw => userLower.includes(kw));
    
    // For urgency, check for values
    if (field === 'urgency') {
      const urgencyValues = ['blocked', 'critical', 'high', 'medium', 'low', 'urgent'];
      if (urgencyValues.some(val => userLower.includes(val))) {
        answeredFields.push(field);
        continue;
      }
    }
    
    // For category, check for values
    if (field === 'category') {
      const categoryValues = ['password', 'hardware', 'software', 'network', 'email', 'other'];
      if (categoryValues.some(val => userLower.includes(val))) {
        answeredFields.push(field);
        continue;
      }
    }
    
    // For other fields, check keywords
    if (hasKeywords || userMessage.length > 20) {
      // If message is substantial and contains field keywords, likely answers this field
      answeredFields.push(field);
    }
  }

  return answeredFields;
};

export default {
  isQuestionAboutField,
  validateAnswerToQuestion,
  identifyAnsweredFields
};

