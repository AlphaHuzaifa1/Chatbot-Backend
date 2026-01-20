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

export const detectSensitiveData = (text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const normalizedText = text.trim();

  for (const { pattern, type, message } of SENSITIVE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match) {
      return {
        detected: true,
        type,
        message,
        matchedText: match[0]
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

