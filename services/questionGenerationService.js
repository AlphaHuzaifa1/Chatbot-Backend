const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

/**
 * Category-specific question templates
 */
const QUESTION_TEMPLATES = {
  password: {
    issue: [
      "What password-related issue are you experiencing?",
      "Can you describe the password problem you're facing?",
      "What's happening with your password or login?"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)",
      "How quickly do you need this resolved? (blocked, high, medium, or low)"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "Is there an error message displayed? If so, what does it say?",
      "What error message (if any) are you seeing?"
    ]
  },
  hardware: {
    issue: [
      "What hardware issue are you experiencing?",
      "Can you describe the hardware problem?",
      "What's wrong with the hardware?"
    ],
    category: [
      "What type of hardware issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which system or device is affected?",
      "What system or application is experiencing the issue?",
      "Which system is having problems?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  },
  software: {
    issue: [
      "What software issue are you experiencing?",
      "Can you describe the software problem?",
      "What's happening with the software?"
    ],
    category: [
      "What type of issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which application or software is affected?",
      "What software or application is experiencing the issue?",
      "Which application is having problems?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  },
  network: {
    issue: [
      "What network issue are you experiencing?",
      "Can you describe the network problem?",
      "What's happening with your network connection?"
    ],
    category: [
      "What type of issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which system or service is affected by the network issue?",
      "What system is experiencing network problems?",
      "Which system is affected?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  },
  email: {
    issue: [
      "What email issue are you experiencing?",
      "Can you describe the email problem?",
      "What's happening with your email?"
    ],
    category: [
      "What type of issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which email system or client is affected?",
      "What email application is experiencing the issue?",
      "Which email system is having problems?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  },
  other: {
    issue: [
      "What issue are you experiencing?",
      "Can you describe the problem?",
      "What's happening?"
    ],
    category: [
      "What type of issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which system or application is affected?",
      "What system is experiencing the issue?",
      "Which system is having problems?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  },
  default: {
    issue: [
      "What issue are you experiencing?",
      "Can you describe the problem?",
      "What's happening?"
    ],
    category: [
      "What type of issue is this? (hardware, software, network, email, password, or other)",
      "Which category best describes this? (hardware, software, network, email, password, or other)"
    ],
    urgency: [
      "How urgent is this? (blocked, high, medium, or low)",
      "What's the urgency level? (blocked, high, medium, or low)"
    ],
    affectedSystem: [
      "Which system or application is affected?",
      "What system is experiencing the issue?",
      "Which system is having problems?"
    ],
    errorText: [
      "Are you seeing any error messages? If yes, what do they say?",
      "What error message (if any) are you seeing?"
    ]
  }
};

/**
 * Get category-aware question template
 */
const getQuestionTemplate = (category, field) => {
  const categoryKey = category || 'default';
  const templates = QUESTION_TEMPLATES[categoryKey] || QUESTION_TEMPLATES.default;
  const fieldTemplates = templates[field] || QUESTION_TEMPLATES.default[field];
  
  if (!fieldTemplates || fieldTemplates.length === 0) {
    // Fallback to generic
    const fieldNames = {
      issue: 'issue description',
      category: 'category',
      urgency: 'urgency level (blocked, high, medium, or low)',
      affectedSystem: 'affected system or application',
      errorText: 'error message (or "no error provided")'
    };
    return `What is the ${fieldNames[field] || field}?`;
  }
  
  // Return random template for variety
  return fieldTemplates[Math.floor(Math.random() * fieldTemplates.length)];
};

/**
 * Generate next question (backend-controlled)
 * @param {string} field - Field to ask about
 * @param {string} category - Current category (if known)
 * @param {string} intent - User intent
 * @param {Array} askedQuestions - Previously asked questions
 * @returns {string} Generated question
 */
export const getNextQuestion = (field, category = null, intent = null, askedQuestions = []) => {
  if (!field) {
    return null;
  }
  
  // Generate base question
  let question = getQuestionTemplate(category, field);
  
  // If clarification intent, rephrase more clearly
  if (intent === 'CLARIFICATION') {
    question = `To clarify: ${question}`;
  }
  
  return question;
};

/**
 * Get field priority order (which field to ask next)
 * @param {Array} missingFields - List of missing fields
 * @param {string} category - Current category (if known)
 * @returns {string} Next field to ask about
 */
export const getNextField = (missingFields, category = null) => {
  if (!missingFields || missingFields.length === 0) {
    return null;
  }
  
  // Priority order
  const priorityOrder = ['issue', 'category', 'urgency', 'affectedSystem', 'errorText'];
  
  // For password category, skip affectedSystem
  if (category === 'password') {
    const filtered = missingFields.filter(f => f !== 'affectedSystem');
    if (filtered.length > 0) {
      // Return first missing field in priority order
      for (const field of priorityOrder) {
        if (filtered.includes(field)) {
          return field;
        }
      }
    }
  }
  
  // Return first missing field in priority order
  for (const field of priorityOrder) {
    if (missingFields.includes(field)) {
      return field;
    }
  }
  
  // Fallback: return first missing field
  return missingFields[0];
};

export default {
  getNextQuestion,
  getNextField
};

