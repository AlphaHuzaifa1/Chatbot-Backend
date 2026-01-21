import { processUserMessage, generateTicketSummary, isOpenAIAvailable } from './openaiService.js';
import { 
  loadSessionState, 
  updateSessionState, 
  canSubmitTicket, 
  canSubmitTicketCategoryAware,
  getMissingFields,
  markSessionSubmitted 
} from './sessionStateService.js';
import { createMessage } from '../models/messageModel.js';
import { detectSensitiveData } from './sensitiveDataDetection.js';
import { submitTicket } from './ticketSubmissionService.js';
import { classifyIntent, INTENT } from './intentClassificationService.js';
import { getNextQuestion, getNextField } from './questionGenerationService.js';
import { isSimilarQuestion } from './semanticSimilarityService.js';

const TEST_MODE = process.env.TEST_MODE === 'true';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

// Submission keywords that trigger immediate submission
const SUBMISSION_KEYWORDS = [
  'submit my ticket',
  'contact support',
  'raise a ticket',
  'i need support now',
  'please submit',
  'submit ticket',
  'create ticket',
  'open ticket'
];

/**
 * Check if user message contains submission keywords
 */
const checkSubmissionKeywords = (userMessage) => {
  const normalized = userMessage.toLowerCase().trim();
  return SUBMISSION_KEYWORDS.some(keyword => normalized.includes(keyword));
};

/**
 * Safe merge: only fill null fields, never overwrite
 */
const safeMergeIntake = (currentIntake, extracted) => {
  const merged = { ...currentIntake };
  
  // Only update fields that are currently null
  if (!merged.issue && extracted.issue) {
    merged.issue = extracted.issue;
  }
  if (!merged.category && extracted.category) {
    merged.category = extracted.category;
  }
  if (!merged.urgency && extracted.urgency) {
    merged.urgency = extracted.urgency;
  }
  if (!merged.affectedSystem && extracted.affectedSystem) {
    merged.affectedSystem = extracted.affectedSystem;
  }
  if ((merged.errorText === null || merged.errorText === undefined) && extracted.errorText !== null && extracted.errorText !== undefined) {
    merged.errorText = extracted.errorText;
  }
  
  return merged;
};

/**
 * Submit ticket helper
 */
const submitTicketHelper = async (sessionId, sessionState) => {
  // Generate ticket summary with AI
  let summaryData;
  try {
    summaryData = await generateTicketSummary(sessionState.intake, sessionState.userContext);
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[AI Chat] Summary generation error:', error.message);
    }
    // Fallback to basic summary
    summaryData = {
      summary: sessionState.intake.issue || 'Support request',
      keyDetails: [
        sessionState.intake.issue ? `Issue: ${sessionState.intake.issue}` : null,
        sessionState.intake.urgency ? `Urgency: ${sessionState.intake.urgency}` : null,
        sessionState.intake.affectedSystem ? `Affected System: ${sessionState.intake.affectedSystem}` : null
      ].filter(Boolean)
    };
  }

  // Generate ticket payload
  const ticketPayload = await generateTicketPayloadFromState(sessionState, summaryData);

  // Submit ticket
  const userId = null; // Simplified for now
  const submissionResult = await submitTicket(ticketPayload, sessionId, userId);
  
  // Mark session as submitted
  await markSessionSubmitted(sessionId);

  // Store system message
  await createMessage({
    sessionId,
    messageText: `Thank you! Your support ticket has been submitted successfully. Reference ID: ${submissionResult.referenceId}`,
    sender: 'system'
  });

  return {
    message: `Thank you! Your support ticket has been submitted successfully. Reference ID: ${submissionResult.referenceId}`,
    type: 'success',
    submitted: true,
    referenceId: submissionResult.referenceId,
    emailSent: submissionResult.emailSent,
    testMode: submissionResult.testMode
  };
};

/**
 * Handle clarification intent
 */
const handleClarification = async (sessionId, sessionState, userMessage, lastQuestion) => {
  if (!lastQuestion) {
    // No previous question to clarify, just acknowledge
    const response = "I'm here to help. Could you tell me more about the issue you're experiencing?";
    await createMessage({
      sessionId,
      messageText: response,
      sender: 'system'
    });
    return {
      message: response,
      type: 'clarification'
    };
  }
  
  // Rephrase the last question
  const response = `Let me rephrase that: ${lastQuestion}`;
  await createMessage({
    sessionId,
    messageText: response,
    sender: 'system'
  });
  return {
    message: response,
    type: 'clarification'
  };
};

/**
 * Handle frustration intent
 */
const handleFrustration = async (sessionId, sessionState, missingFields) => {
  const intake = sessionState.intake || {};
  const collectedSummary = [];
  if (intake.issue) collectedSummary.push(`Issue: ${intake.issue}`);
  if (intake.category) collectedSummary.push(`Category: ${intake.category}`);
  if (intake.urgency) collectedSummary.push(`Urgency: ${intake.urgency}`);
  
  let response;
  if (collectedSummary.length > 0) {
    response = `I apologize for the confusion. Let me summarize what I have so far:\n\n${collectedSummary.join('\n')}\n\n`;
    
    if (missingFields.length > 0) {
      const nextField = getNextField(missingFields, intake.category);
      if (nextField) {
        const question = getNextQuestion(nextField, intake.category, INTENT.FRUSTRATION, sessionState.askedQuestions);
        response += `I just need one more thing: ${question}`;
      } else {
        response += 'Would you like me to submit your ticket with the information we have so far?';
      }
    } else {
      response += 'Would you like me to submit your ticket now?';
    }
  } else {
    response = "I apologize for the frustration. Let's start fresh. What issue are you experiencing?";
  }
  
  await createMessage({
    sessionId,
    messageText: response,
    sender: 'system'
  });
  
  return {
    message: response,
    type: 'frustration_handling'
  };
};

/**
 * Handle greeting intent
 */
const handleGreeting = async (sessionId) => {
  const response = "Hello! I'm here to help you with your IT support request. What's going on?";
  await createMessage({
    sessionId,
    messageText: response,
    sender: 'system'
  });
  return {
    message: response,
    type: 'greeting'
  };
};

/**
 * Process a user message with AI (conversational, intent-aware)
 * @param {string} sessionId - Session ID
 * @param {string} userMessage - User's message
 * @returns {Promise<Object>} Response object with message and metadata
 */
export const processMessage = async (sessionId, userMessage) => {
  const startTime = Date.now();
  
  // Load session state
  let sessionState = await loadSessionState(sessionId);
  if (!sessionState) {
    throw new Error('Session not found');
  }

  // Submission lock: ignore all messages after submission
  if (sessionState.isSubmitted) {
    return {
      message: 'Your ticket has already been submitted. Please start a new session for additional support.',
      type: 'info',
      submitted: true
    };
  }

  // Check for sensitive data first (backend validation)
  const sensitiveCheck = detectSensitiveData(userMessage);
  if (sensitiveCheck.detected) {
    // Don't store the message
    return {
      message: sensitiveCheck.message,
      type: 'warning',
      sensitive: true
    };
  }

  // Store user message
  await createMessage({
    sessionId,
    messageText: userMessage,
    sender: 'user'
  });

  // Update session state with message
  sessionState = await updateSessionState(sessionId, {
    message: {
      sender: 'user',
      message: userMessage,
      timestamp: new Date()
    }
  });

  // Classify user intent (rule-based + AI fallback)
  const intent = await classifyIntent(userMessage, sessionState.messages || []);
  
  // Store intent in session state for observability (memory only, not persisted)
  sessionState = await updateSessionState(sessionId, {
    lastIntent: intent
  });

  // Compute missing fields BEFORE any AI call
  const missingFields = getMissingFields(sessionState);

  // If no missing fields, submit immediately
  if (missingFields.length === 0) {
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] All fields collected, submitting immediately');
    }
    try {
      const result = await submitTicketHelper(sessionId, sessionState);
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Observability:', {
          intent,
          missingFields: [],
          questionChosen: 'SUBMIT',
          submissionDecision: 'AUTO_COMPLETE',
          latency: `${Date.now() - startTime}ms`
        });
      }
      return result;
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] Submission error:', error.message);
      }
      return {
        message: 'There was an issue submitting your ticket. Please contact support directly.',
        type: 'error',
        error: error.message
      };
    }
  }

  // Handle SUBMIT_REQUEST intent immediately
  if (intent === INTENT.SUBMIT_REQUEST || checkSubmissionKeywords(userMessage)) {
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Submission request detected, submitting with available data');
    }
    try {
      const result = await submitTicketHelper(sessionId, sessionState);
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Observability:', {
          intent,
          missingFields,
          questionChosen: 'SUBMIT',
          submissionDecision: 'USER_REQUEST',
          latency: `${Date.now() - startTime}ms`
        });
      }
      return result;
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] Submission error:', error.message);
      }
      return {
        message: 'There was an issue submitting your ticket. Please contact support directly.',
        type: 'error',
        error: error.message
      };
    }
  }

  // Handle GREETING intent (only if conversation is truly starting)
  if (intent === INTENT.GREETING) {
    // Only handle greeting if there's no conversation history or very minimal
    const hasHistory = sessionState.messages && sessionState.messages.length > 2;
    const hasProgress = sessionState.intake.issue || sessionState.intake.category || 
                       sessionState.intake.urgency || sessionState.intake.affectedSystem;
    
    // If there's already progress, treat greeting as answer and continue conversation
    if (hasHistory || hasProgress) {
      // Don't reset, just acknowledge and continue
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Greeting detected but conversation in progress, treating as answer');
      }
      // Fall through to normal processing
    } else {
      // Truly a new conversation
      const result = await handleGreeting(sessionId);
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Observability:', {
          intent,
          missingFields,
          questionChosen: 'GREETING',
          submissionDecision: 'NONE',
          latency: `${Date.now() - startTime}ms`
        });
      }
      return result;
    }
  }

  // Handle FRUSTRATION intent
  if (intent === INTENT.FRUSTRATION) {
    const result = await handleFrustration(sessionId, sessionState, missingFields);
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Observability:', {
        intent,
        missingFields,
        questionChosen: 'FRUSTRATION_HANDLING',
        submissionDecision: 'NONE',
        latency: `${Date.now() - startTime}ms`
      });
    }
    return result;
  }

  // Handle CLARIFICATION intent (don't extract new fields, don't ask new questions)
  if (intent === INTENT.CLARIFICATION) {
    const lastQuestion = sessionState.askedQuestions && sessionState.askedQuestions.length > 0
      ? sessionState.askedQuestions[sessionState.askedQuestions.length - 1]
      : null;
    const result = await handleClarification(sessionId, sessionState, userMessage, lastQuestion);
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Observability:', {
        intent,
        missingFields,
        questionChosen: 'CLARIFICATION',
        submissionDecision: 'NONE',
        latency: `${Date.now() - startTime}ms`
      });
    }
    return result;
  }

  // Try to process with OpenAI for extraction
  let aiResponse;
  let useFallback = false;
  let aiErrorCount = 0;
  let openaiLatency = 0;

  if (isOpenAIAvailable()) {
    try {
      const aiStartTime = Date.now();
      aiResponse = await processUserMessage(userMessage, sessionState, missingFields, intent);
      openaiLatency = Date.now() - aiStartTime;
    } catch (error) {
      aiErrorCount++;
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] OpenAI error:', error.message);
      }
      // If OpenAI fails more than 2 times, use fallback
      if (aiErrorCount > 2) {
        useFallback = true;
      } else {
        // Retry once
        try {
          const aiStartTime = Date.now();
          aiResponse = await processUserMessage(userMessage, sessionState, missingFields, intent);
          openaiLatency = Date.now() - aiStartTime;
        } catch (retryError) {
          useFallback = true;
        }
      }
    }
  } else {
    useFallback = true;
  }

  // Fallback mode: simple text collection
  if (useFallback) {
    return await handleFallbackMode(sessionId, userMessage, sessionState, missingFields);
  }

  // Safe merge: only fill null fields
  let extracted = aiResponse.extracted || {};
  
  // Fallback extraction for common short answers (if OpenAI didn't extract)
  // This helps with short answers like "high", "software", etc.
  if (intent === INTENT.ANSWER || intent === INTENT.UNKNOWN) {
    const normalized = userMessage.toLowerCase().trim();
    const lastQuestion = sessionState.askedQuestions && sessionState.askedQuestions.length > 0
      ? sessionState.askedQuestions[sessionState.askedQuestions.length - 1]?.toLowerCase() || ''
      : '';
    
    // If last question was about urgency and user said a urgency level
    if (lastQuestion.includes('urgency') || lastQuestion.includes('urgent')) {
      if (['blocked', 'critical'].some(u => normalized.includes(u))) {
        extracted.urgency = 'blocked';
      } else if (['high', 'urgent'].some(u => normalized.includes(u))) {
        extracted.urgency = 'high';
      } else if (normalized.includes('medium')) {
        extracted.urgency = 'medium';
      } else if (['low', 'minor'].some(u => normalized.includes(u))) {
        extracted.urgency = 'low';
      }
    }
    
    // If last question was about category and user said a category
    if (lastQuestion.includes('category') || lastQuestion.includes('type')) {
      const categories = ['password', 'hardware', 'software', 'network', 'email', 'other'];
      for (const cat of categories) {
        if (normalized.includes(cat)) {
          extracted.category = cat;
          break;
        }
      }
    }
  }
  
  const mergedIntake = safeMergeIntake(sessionState.intake, extracted);

  // Update session state with merged intake
  if (JSON.stringify(mergedIntake) !== JSON.stringify(sessionState.intake)) {
    sessionState = await updateSessionState(sessionId, {
      intake: mergedIntake
    });
    
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Extracted and merged:', {
        extracted,
        mergedIntake,
        previousIntake: sessionState.intake
      });
    }
  }

  // Recompute missing fields after merge
  const updatedMissingFields = getMissingFields(sessionState);

  // Check if ready to submit (category-aware, backend decides)
  const readyToSubmit = canSubmitTicketCategoryAware(sessionState);

  if (readyToSubmit) {
    try {
      const result = await submitTicketHelper(sessionId, sessionState);
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Observability:', {
          intent,
          missingFields: updatedMissingFields,
          questionChosen: 'SUBMIT',
          submissionDecision: 'BACKEND_VALIDATION',
          openaiLatency: `${openaiLatency}ms`,
          latency: `${Date.now() - startTime}ms`
        });
      }
      return result;
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] Submission error:', error.message);
      }
      return {
        message: 'There was an issue submitting your ticket. Please contact support directly.',
        type: 'error',
        error: error.message
      };
    }
  }

  // Backend-controlled question generation
  const category = sessionState.intake.category || null;
  const nextField = getNextField(updatedMissingFields, category);
  
  if (!nextField) {
    // Should not happen, but handle gracefully
    const result = await submitTicketHelper(sessionId, sessionState);
    return result;
  }

  // Generate question (backend-controlled with OpenAI suggestion as optional enhancement)
  let nextQuestion = getNextQuestion(nextField, category, intent, sessionState.askedQuestions || []);
  
  // Use OpenAI suggestion if available and not semantically similar to asked questions
  if (aiResponse.suggestedQuestion && 
      !isSimilarQuestion(aiResponse.suggestedQuestion, sessionState.askedQuestions || [])) {
    // Check if OpenAI suggestion is about the same field we want to ask
    const suggestedLower = aiResponse.suggestedQuestion.toLowerCase();
    const fieldKeywords = {
      issue: ['issue', 'problem', 'what', 'describe'],
      category: ['category', 'type', 'kind'],
      urgency: ['urgency', 'urgent', 'priority'],
      affectedSystem: ['system', 'application', 'app', 'which'],
      errorText: ['error', 'message']
    };
    
    const keywords = fieldKeywords[nextField] || [];
    if (keywords.some(kw => suggestedLower.includes(kw))) {
      nextQuestion = aiResponse.suggestedQuestion;
    }
  }

  // Prevent semantic repeats
  if (isSimilarQuestion(nextQuestion, sessionState.askedQuestions || [])) {
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Semantically similar question detected, generating alternative');
    }
    // Generate alternative phrasing
    nextQuestion = getNextQuestion(nextField, category, intent, sessionState.askedQuestions || []);
    
    // If still similar, try a different approach
    if (isSimilarQuestion(nextQuestion, sessionState.askedQuestions || [])) {
      // Acknowledge and move forward
      const collected = sessionState.intake[nextField] ? 'I understand.' : '';
      nextQuestion = `${collected} ${getNextQuestion(nextField, category, 'CLARIFICATION', sessionState.askedQuestions || [])}`.trim();
    }
  }

  // Store asked question
  await updateSessionState(sessionId, {
    askedQuestions: [nextQuestion]
  });

  // Store system message
  await createMessage({
    sessionId,
    messageText: nextQuestion,
    sender: 'system'
  });

  // Observability logging
  if (ENABLE_LOGGING) {
    console.log('[AI Chat] Observability:', {
      intent,
      missingFields: updatedMissingFields,
      questionChosen: nextQuestion.substring(0, 50) + '...',
      submissionDecision: 'CONTINUE',
      openaiLatency: `${openaiLatency}ms`,
      latency: `${Date.now() - startTime}ms`,
      confidence: aiResponse.confidence || 'unknown'
    });
  }

  return {
    message: nextQuestion,
    type: 'question',
    readyToSubmit: false
  };
};

/**
 * Fallback mode: simple text collection
 */
const handleFallbackMode = async (sessionId, userMessage, sessionState, missingFields) => {
  if (ENABLE_LOGGING) {
    console.log('[AI Chat] Using fallback mode');
  }

  // If this is first message, ask for all info at once
  if (missingFields.length === 5) {
    const fallbackQuestion = 'Please briefly describe the issue, urgency (blocked/high/medium/low), affected system, and any error text.';
    
    await createMessage({
      sessionId,
      messageText: fallbackQuestion,
      sender: 'system'
    });

    await updateSessionState(sessionId, {
      askedQuestions: [fallbackQuestion]
    });

    return {
      message: fallbackQuestion,
      type: 'question',
      fallback: true
    };
  }

  // Try to extract basic info from user message
  const lowerMessage = userMessage.toLowerCase();
  
  // Extract urgency if mentioned
  let urgency = null;
  if (lowerMessage.includes('blocked') || lowerMessage.includes('critical')) urgency = 'blocked';
  else if (lowerMessage.includes('high') || lowerMessage.includes('urgent')) urgency = 'high';
  else if (lowerMessage.includes('medium')) urgency = 'medium';
  else if (lowerMessage.includes('low') || lowerMessage.includes('minor')) urgency = 'low';

  // Extract category if mentioned
  let category = null;
  if (lowerMessage.includes('password') || lowerMessage.includes('login')) category = 'password';
  else if (lowerMessage.includes('hardware') || lowerMessage.includes('device')) category = 'hardware';
  else if (lowerMessage.includes('software') || lowerMessage.includes('application')) category = 'software';
  else if (lowerMessage.includes('network') || lowerMessage.includes('internet')) category = 'network';
  else if (lowerMessage.includes('email') || lowerMessage.includes('mail')) category = 'email';

  // Update intake with extracted info
  const intakeUpdates = {};
  if (!sessionState.intake.issue && userMessage.length > 10) {
    intakeUpdates.issue = userMessage;
  }
  if (!sessionState.intake.urgency && urgency) {
    intakeUpdates.urgency = urgency;
  }
  if (!sessionState.intake.category && category) {
    intakeUpdates.category = category;
  }
  if (!sessionState.intake.affectedSystem) {
    intakeUpdates.affectedSystem = 'Unknown';
  }
  if (sessionState.intake.errorText === null || sessionState.intake.errorText === undefined) {
    intakeUpdates.errorText = 'no error provided';
  }

  if (Object.keys(intakeUpdates).length > 0) {
    sessionState = await updateSessionState(sessionId, {
      intake: intakeUpdates
    });
  }

  // Check if we can submit now
  const newMissingFields = getMissingFields(sessionState);
  if (newMissingFields.length === 0 || canSubmitTicketCategoryAware(sessionState)) {
    try {
      return await submitTicketHelper(sessionId, sessionState);
    } catch (error) {
      return {
        message: 'There was an issue submitting your ticket. Please contact support directly.',
        type: 'error',
        fallback: true
      };
    }
  }

  // Ask about remaining missing fields
  const fieldNames = {
    issue: 'issue description',
    category: 'category',
    urgency: 'urgency level',
    affectedSystem: 'affected system',
    errorText: 'error message'
  };
  const firstMissing = newMissingFields[0];
  const fallbackQuestion = `What is the ${fieldNames[firstMissing] || firstMissing}?`;

  await createMessage({
    sessionId,
    messageText: fallbackQuestion,
    sender: 'system'
  });

  await updateSessionState(sessionId, {
    askedQuestions: [fallbackQuestion]
  });

  return {
    message: fallbackQuestion,
    type: 'question',
    fallback: true
  };
};

/**
 * Generate ticket payload from session state
 */
const generateTicketPayloadFromState = async (sessionState, summaryData) => {
  const intake = sessionState.intake;
  const userContext = sessionState.userContext;

  return {
    sessionId: sessionState.sessionId,
    createdAt: new Date().toISOString(),
    customer: {
      fullName: userContext.fullName || 'Not provided',
      email: userContext.email || 'Not provided',
      phone: userContext.phone || 'Not provided',
      company: userContext.company || 'Not provided',
      vsaAgentName: userContext.vsaAgent || 'Not provided'
    },
    category: intake.category || 'other',
    urgency: intake.urgency || 'medium',
    impact: intake.urgency === 'blocked' ? 'blocked' : 'single_user',
    summary: summaryData.summary,
    details: {
      problemDescription: intake.issue || 'Not provided',
      urgency: intake.urgency || 'Not specified',
      affectedSystem: intake.affectedSystem || 'Not specified',
      errorMessage: intake.errorText === 'no error provided' || !intake.errorText 
        ? 'No error message provided' 
        : (intake.errorText || 'Not provided'),
      additionalContext: null
    },
    keyDetails: summaryData.keyDetails || [],
    chatTranscript: sessionState.messages || [],
    metadata: {
      sessionStatus: 'active',
      intakeStatus: 'complete',
      sessionCreatedAt: sessionState.createdAt,
      sessionUpdatedAt: new Date()
    }
  };
};

export default {
  processMessage
};


