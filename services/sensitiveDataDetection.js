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
 * Intent-based sensitive data detection patterns
 * Catches user intent to share sensitive data, not just literal patterns
 */
const INTENT_TO_SHARE_PATTERNS = [
  {
    pattern: /(i will share|i'll share|can i send|here is my|let me give you|i want to share)/i,
    type: 'intent_to_share',
    message: 'I understand you want to share information, but for security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need password reset assistance, I can guide you through the proper process.'
  },
  {
    pattern: /(should i send|can i provide|do you need my|would you like my)/i,
    type: 'intent_to_share',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need help with authentication, I can guide you through the proper process.'
  },
  {
    pattern: /(my password is|my pin is|my code is|my token is|my otp is)/i,
    type: 'intent_to_share',
    message: 'Please do not share passwords, PINs, codes, or tokens. For security reasons, we cannot accept sensitive credentials through this chat. If you need password reset assistance, I can help guide you through the proper process.'
  },
  {
    // Only match if user is explicitly saying they will share/send/give password
    // Exclude common phrases like "resetting password", "forgot password", "password reset"
    // Require explicit action words like "will share", "can send", "want to give"
    pattern: /(password|pin|code|token|otp|mfa|credentials).*(?:will|can|should|want to|going to|let me|i'll|i will).*(?:share|send|give|provide|tell|show)/i,
    type: 'intent_to_share',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need authentication help, I can guide you through the proper process.'
  },
  {
    // Match explicit sharing statements - user saying they will share credentials
    pattern: /(?:will|can|should|want to|going to|let me|i'll|i will).*(?:share|send|give|provide|tell|show).*(?:password|pin|code|token|otp|mfa|credentials|account).*(?:with you|to you)/i,
    type: 'intent_to_share',
    message: 'For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need authentication help, I can guide you through the proper process.'
  }
];

/**
 * Detect sensitive data - Enhanced with intent-based detection
 * Now catches both literal sensitive data AND intent to share it
 */
export const detectSensitiveData = (text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const normalizedText = text.trim();

  // First check for intent to share (proactive prevention)
  for (const { pattern, type, message } of INTENT_TO_SHARE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      return {
        detected: true,
        type,
        message,
        matchedText: match[0],
        isIntentBased: true // Flag to indicate this is intent-based, not literal data
      };
    }
  }

  // Then check for literal sensitive data patterns
  for (const { pattern, type, message } of SENSITIVE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      return {
        detected: true,
        type,
        message,
        matchedText: match[0],
        isIntentBased: false
      };
    }
  }

  return {
    detected: false
  };
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

