const SENSITIVE_PATTERNS = [
  {
    pattern: /password\s*[:=]\s*['"]?([^'"\s]{6,})['"]?/i,
    type: 'password',
    message: 'Please do not share passwords. For security reasons, we cannot accept passwords through this chat.'
  },
  {
    pattern: /(?:mfa|2fa|two-factor|verification)\s*(?:code|token|number)\s*[:=]\s*['"]?([^'"\s]{4,})['"]?/i,
    type: 'mfa_code',
    message: 'Please do not share MFA or verification codes. These are sensitive and should not be shared.'
  },
  {
    pattern: /(?:api\s*key|access\s*token|secret\s*key|auth\s*token)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/i,
    type: 'api_credential',
    message: 'Please do not share API keys, tokens, or credentials. These are sensitive and should not be shared.'
  },
  {
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    type: 'credit_card',
    message: 'Please do not share credit card numbers or financial information through this chat.'
  },
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    type: 'ssn',
    message: 'Please do not share Social Security Numbers or personal identification numbers.'
  },
  {
    pattern: /(?:pin|personal\s*identification\s*number)\s*[:=]\s*['"]?(\d{4,})['"]?/i,
    type: 'pin',
    message: 'Please do not share PINs or personal identification numbers.'
  }
];

/**
 * HIGH-RISK intent patterns: Explicitly mention credentials AND intent to share
 * These patterns require credential keywords (password, code, token, pin, otp, mfa, credentials)
 * AND sharing language. These are ALWAYS blocked.
 */
const HIGH_RISK_INTENT_PATTERNS = [
  {
    pattern: /(my password is|my pin is|my code is|my token is|my otp is)/i,
    type: 'high_risk_intent',
    message: 'Please do not share passwords, PINs, codes, or tokens. For security reasons, we cannot accept sensitive credentials through this chat. If you need password reset assistance, I can help guide you through the proper process.'
  },
  {
    // Match if user explicitly says they will share/send/give password/credentials
    // Requires credential keyword AND sharing action
    pattern: /(password|pin|code|token|otp|mfa|credentials).*(?:will|can|should|want to|going to|let me|i'll|i will).*(?:share|send|give|provide|tell|show)/i,
    type: 'high_risk_intent',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need authentication help, I can guide you through the proper process.'
  },
  {
    // Match explicit sharing statements with credentials - user saying they will share credentials
    pattern: /(?:will|can|should|want to|going to|let me|i'll|i will).*(?:share|send|give|provide|tell|show).*(?:password|pin|code|token|otp|mfa|credentials).*(?:with you|to you)/i,
    type: 'high_risk_intent',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need authentication help, I can guide you through the proper process.'
  }
];

/**
 * GENERIC_SHARE_LANGUAGE: Phrases that indicate sharing intent but WITHOUT credential keywords
 * These are SAFE by default and only trigger BLOCK if combined with credential keywords.
 * Error messages, logs, screenshots, or "exact error message" references are SAFE.
 */
const GENERIC_SHARE_LANGUAGE_PATTERNS = [
  {
    pattern: /(i will share|i'll share|can i send|here is my|let me give you|i want to share)/i,
    type: 'generic_share_language',
    message: 'I understand you want to share information, but for security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need password reset assistance, I can guide you through the proper process.'
  },
  {
    pattern: /(should i send|can i provide|do you need my|would you like my)/i,
    type: 'generic_share_language',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need help with authentication, I can guide you through the proper process.'
  }
];

/**
 * Credential keywords that indicate sensitive data sharing
 */
const CREDENTIAL_KEYWORDS = /\b(password|pin|code|token|otp|mfa|2fa|two-factor|verification|credentials|secret|api\s*key|auth\s*token)\b/i;

/**
 * Safe context keywords that indicate non-sensitive sharing (error messages, logs, etc.)
 */
const SAFE_CONTEXT_KEYWORDS = /\b(error\s*message|error\s*text|exact\s*error|error\s*code|log|logs|screenshot|screenshots|details|information|message|text|output|result)\b/i;

/**
 * Detect sensitive data - Context-aware with refined intent detection
 * 
 * @param {string} text - User message text
 * @param {Object} context - Conversation context
 * @param {string} context.conversationState - Current conversation state (WAITING, INTAKE, etc.)
 * @param {string} context.lastBotMessage - Last assistant message text
 * @param {Object} context.intakeContext - Current intake fields being discussed
 * @returns {Object} Detection result with structured logging metadata
 */
export const detectSensitiveData = (text, context = {}) => {
  if (!text || typeof text !== 'string') {
    return {
      detected: false,
      decision: 'PASS',
      reason: 'Invalid input'
    };
  }

  const normalizedText = text.trim();
  const { conversationState, lastBotMessage = '', lastExpectedField = null, intakeContext = {} } = context;
  
  // Structured logging metadata
  const logMetadata = {
    timestamp: new Date().toISOString(),
    textLength: text.length,
    normalizedText: normalizedText.substring(0, 100), // Safe truncation for logging
    conversationState: conversationState || 'unknown'
  };

  // ============================================
  // STEP 1: Check for literal sensitive data patterns (ALWAYS BLOCK)
  // ============================================
  for (const { pattern, type, message } of SENSITIVE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      const result = {
        detected: true,
        type,
        message,
        matchedText: match[0],
        isIntentBased: false,
        decision: 'BLOCK',
        patternType: 'LITERAL_SENSITIVE_DATA',
        logMetadata: {
          ...logMetadata,
          matchedPattern: pattern.toString(),
          matchedText: match[0].substring(0, 20) // Safe truncation
        }
      };
      
      if (process.env.ENABLE_LOGGING !== 'false') {
        console.log('[Security Detection] BLOCK - Literal sensitive data:', JSON.stringify(result.logMetadata));
      }
      
      return result;
    }
  }

  // ============================================
  // STEP 2: Check HIGH_RISK_INTENT patterns (ALWAYS BLOCK)
  // These explicitly mention credentials AND sharing intent
  // ============================================
  for (const { pattern, type, message } of HIGH_RISK_INTENT_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      const result = {
        detected: true,
        type,
        message,
        matchedText: match[0],
        isIntentBased: true,
        decision: 'BLOCK',
        patternType: 'HIGH_RISK_INTENT',
        logMetadata: {
          ...logMetadata,
          matchedPattern: pattern.toString(),
          matchedText: match[0].substring(0, 50)
        }
      };
      
      if (process.env.ENABLE_LOGGING !== 'false') {
        console.log('[Security Detection] BLOCK - High-risk intent:', JSON.stringify(result.logMetadata));
      }
      
      return result;
    }
  }

  // ============================================
  // STEP 3: Check GENERIC_SHARE_LANGUAGE patterns
  // These are SAFE by default unless combined with credential keywords
  // ============================================
  let genericShareMatch = null;
  for (const { pattern, type, message } of GENERIC_SHARE_LANGUAGE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      genericShareMatch = { pattern, type, message, matchedText: match[0] };
      break; // Use first match
    }
  }

  if (genericShareMatch) {
    // Check if credential keywords are present
    const hasCredentialKeywords = CREDENTIAL_KEYWORDS.test(normalizedText);
    
    // Check if safe context keywords are present (error messages, logs, etc.)
    const hasSafeContextKeywords = SAFE_CONTEXT_KEYWORDS.test(normalizedText);
    
    // Context-aware downgrade: If user mentions safe context keywords (error message, etc.),
    // treat as SAFE regardless of state. Error messages are always safe to share.
    // Also check if we're in WAITING/PROBING/READY_TO_SUBMIT and bot was asking about errors
    const isDiscussingErrors = conversationState === 'WAITING' || 
                                conversationState === 'PROBING' || 
                                conversationState === 'INTAKE' ||
                                conversationState === 'READY_TO_SUBMIT'; // Allow in READY_TO_SUBMIT too
    const botAskedAboutErrors = lastBotMessage && 
      /\b(error|error\s*message|error\s*text|exact\s*error|what\s*error|share.*error|send.*error)\b/i.test(lastBotMessage);
    const intakeDiscussesErrors = intakeContext.errorText !== null && intakeContext.errorText !== undefined;
    const botAskedForErrorField = lastExpectedField === 'errorText' || 
      (lastBotMessage && /\b(error|error\s*message|error\s*text)\b/i.test(lastBotMessage));
    // If user explicitly mentions "error message" in their text, always treat as SAFE
    const userExplicitlyMentionsError = /\b(error\s*message|exact\s*error|error\s*text|error\s*code)\b/i.test(normalizedText);
    
    const contextIndicatesSafeSharing = hasSafeContextKeywords && 
      (userExplicitlyMentionsError || // User explicitly mentions error message - always safe
       (isDiscussingErrors && (botAskedAboutErrors || botAskedForErrorField || intakeDiscussesErrors))); // Or we're discussing errors in context

    // Decision logic:
    // - BLOCK if credential keywords present (even with safe context)
    // - SAFE if safe context keywords AND we're discussing errors
    // - BLOCK if generic share language without safe context
    if (hasCredentialKeywords) {
      // Credential keywords present - BLOCK even if safe context mentioned
      const result = {
        detected: true,
        type: genericShareMatch.type,
        message: genericShareMatch.message,
        matchedText: genericShareMatch.matchedText,
        isIntentBased: true,
        decision: 'BLOCK',
        patternType: 'GENERIC_SHARE_LANGUAGE_WITH_CREDENTIALS',
        logMetadata: {
          ...logMetadata,
          matchedPattern: genericShareMatch.pattern.toString(),
          matchedText: genericShareMatch.matchedText.substring(0, 50),
          hasCredentialKeywords: true,
          hasSafeContextKeywords,
          contextIndicatesSafeSharing: false
        }
      };
      
      if (process.env.ENABLE_LOGGING !== 'false') {
        console.log('[Security Detection] BLOCK - Generic share language with credentials:', JSON.stringify(result.logMetadata));
      }
      
      return result;
    } else if (contextIndicatesSafeSharing) {
      // Safe context detected - allow through
      const result = {
        detected: false,
        decision: 'SAFE',
        patternType: 'GENERIC_SHARE_LANGUAGE_SAFE_CONTEXT',
        logMetadata: {
          ...logMetadata,
          matchedPattern: genericShareMatch.pattern.toString(),
          matchedText: genericShareMatch.matchedText.substring(0, 50),
          hasCredentialKeywords: false,
          hasSafeContextKeywords: true,
          contextIndicatesSafeSharing: true,
          reason: 'Safe context detected (error messages/logs)'
        }
      };
      
      if (process.env.ENABLE_LOGGING !== 'false') {
        console.log('[Security Detection] SAFE - Generic share language in safe context:', JSON.stringify(result.logMetadata));
      }
      
      return result;
    } else {
      // Generic share language without credential keywords AND without safe context
      // This is ambiguous - could be safe (sharing error message) or risky (sharing something else)
      // Default to BLOCK for safety, but log the ambiguity
      const result = {
        detected: true,
        type: genericShareMatch.type,
        message: genericShareMatch.message,
        matchedText: genericShareMatch.matchedText,
        isIntentBased: true,
        decision: 'BLOCK',
        patternType: 'GENERIC_SHARE_LANGUAGE_AMBIGUOUS',
        logMetadata: {
          ...logMetadata,
          matchedPattern: genericShareMatch.pattern.toString(),
          matchedText: genericShareMatch.matchedText.substring(0, 50),
          hasCredentialKeywords: false,
          hasSafeContextKeywords,
          contextIndicatesSafeSharing: false,
          reason: 'Generic share language without safe context indicators'
        }
      };
      
      if (process.env.ENABLE_LOGGING !== 'false') {
        console.log('[Security Detection] BLOCK - Generic share language (ambiguous):', JSON.stringify(result.logMetadata));
      }
      
      return result;
    }
  }

  // ============================================
  // STEP 4: No sensitive data or sharing intent detected
  // ============================================
  const result = {
    detected: false,
    decision: 'PASS',
    logMetadata: {
      ...logMetadata,
      reason: 'No sensitive patterns detected'
    }
  };
  
  if (process.env.ENABLE_LOGGING !== 'false') {
    console.log('[Security Detection] PASS - No sensitive data:', JSON.stringify(result.logMetadata));
  }
  
  return result;
};

export const sanitizeMessage = (text) => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let sanitized = text;
  for (const { pattern } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      return '[REDACTED]';
    });
  }

  return sanitized;
};

