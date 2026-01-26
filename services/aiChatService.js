import { processUserMessage, generateTicketSummary, isOpenAIAvailable } from './openaiService.js';
import { 
  loadSessionState, 
  updateSessionState, 
  canSubmitTicket, 
  canSubmitTicketCategoryAware,
  getMissingFields,
  markSessionSubmitted,
  CONVERSATION_MODE
} from './sessionStateService.js';
import { createMessage } from '../models/messageModel.js';
import { detectSensitiveData } from './sensitiveDataDetection.js';
import { submitTicket } from './ticketSubmissionService.js';
import { classifyIntent, INTENT } from './intentClassificationService.js';
import { getNextQuestion, getNextField } from './questionGenerationService.js';
import { isSimilarQuestion } from './semanticSimilarityService.js';
import { validateAnswerToQuestion, identifyAnsweredFields } from './answerQuestionCorrelation.js';
import { reasonAboutConversation, validateExtractedFields } from './conversationBrainService.js';

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
 * Build submission summary for confirmation
 */
const buildSubmissionSummary = (sessionState) => {
  const intake = sessionState.intake;
  const summaryParts = [];
  
  if (intake.issue) {
    summaryParts.push(`Issue: ${intake.issue}`);
  }
  if (intake.category) {
    summaryParts.push(`Category: ${intake.category}`);
  }
  if (intake.urgency) {
    summaryParts.push(`Urgency: ${intake.urgency}`);
  }
  if (intake.affectedSystem) {
    summaryParts.push(`Affected System: ${intake.affectedSystem}`);
  }
  if (intake.errorText && intake.errorText !== 'no error provided') {
    summaryParts.push(`Error: ${intake.errorText}`);
  }
  
  return `Here's what I understood:\n\n${summaryParts.join('\n')}`;
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

  // Check for sensitive data first (backend validation) - Enhanced with intent-based detection
  const sensitiveCheck = detectSensitiveData(userMessage);
  if (sensitiveCheck.detected) {
    // Enter security warning lock mode
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.SECURITY_WARNING
    });
    
    // Don't store the message
    const warningMessage = sensitiveCheck.isIntentBased
      ? sensitiveCheck.message + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.'
      : sensitiveCheck.message;
    
    return {
      message: warningMessage,
      type: 'warning',
      sensitive: true,
      conversationMode: CONVERSATION_MODE.SECURITY_WARNING,
      requiresAcknowledgment: sensitiveCheck.isIntentBased
    };
  }
  
  // If in security warning mode, check for acknowledgment
  if (sessionState.conversationMode === CONVERSATION_MODE.SECURITY_WARNING) {
    const normalized = userMessage.toLowerCase().trim();
    const acknowledgmentPattern = /^(i understand|understood|got it|ok|okay|i won't|i will not)/i;
    
    if (acknowledgmentPattern.test(normalized)) {
      // User acknowledged, resume intake
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.INTAKE
      });
      
      await createMessage({
        sessionId,
        messageText: userMessage,
        sender: 'user'
      });
      
      const response = "Thank you for understanding. Now, let's continue with your support request. What issue are you experiencing?";
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      
      return {
        message: response,
        type: 'info'
      };
    } else {
      // User didn't acknowledge, show warning again
      return {
        message: "For security reasons, I cannot proceed until you acknowledge that you understand not to share sensitive information. Please type 'I understand' to continue.",
        type: 'warning',
        conversationMode: CONVERSATION_MODE.SECURITY_WARNING
      };
    }
  }

  // Classify user intent BEFORE storing message (for off-topic detection)
  // Enhanced: now returns {intent, confidence} and uses lastExpectedField for context
  const intentResult = await classifyIntent(
    userMessage, 
    sessionState.messages || [],
    sessionState.lastExpectedField || null
  );
  const intent = intentResult.intent;
  const intentConfidence = intentResult.confidence;
  
  // Handle SECURITY_RISK intent immediately (before storing message)
  if (intent === INTENT.SECURITY_RISK) {
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.SECURITY_WARNING,
      lastIntent: intent
    });
    
    const securityResponse = "For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need password reset assistance, I can guide you through the proper process. Please acknowledge that you understand by typing 'I understand'.";
    
    return {
      message: securityResponse,
      type: 'warning',
      sensitive: true,
      conversationMode: CONVERSATION_MODE.SECURITY_WARNING,
      requiresAcknowledgment: true
    };
  }
  
  // Handle OFF_TOPIC intent immediately (before storing message)
  if (intent === INTENT.OFF_TOPIC) {
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.OFF_TOPIC,
      lastIntent: intent
    });
    
    const offTopicResponse = "I'm here to help with your IT support issue. Could you tell me more about the technical problem you're experiencing?";
    await createMessage({
      sessionId,
      messageText: offTopicResponse,
      sender: 'system'
    });
    
    return {
      message: offTopicResponse,
      type: 'redirect',
      conversationMode: CONVERSATION_MODE.OFF_TOPIC
    };
  }
  
  // Handle CANCEL intent (user wants to cancel or has no issue)
  if (intent === INTENT.CANCEL) {
    const normalized = userMessage.toLowerCase().trim();
    
    // Check if user said they have no issue/problem
    const noIssuePattern = /(no issue|no problem|don't have|dont have|not facing|nothing wrong|everything is fine|all good)/i;
    if (noIssuePattern.test(normalized)) {
      // Pause intake and ask clarifying question
      const cancelResponse = "I understand you don't have any issues right now. Do you need IT support right now, or should I close this chat?";
      await createMessage({
        sessionId,
        messageText: userMessage,
        sender: 'user'
      });
      await createMessage({
        sessionId,
        messageText: cancelResponse,
        sender: 'system'
      });
      
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.OFF_TOPIC // Pause intake
      });
      
      return {
        message: cancelResponse,
        type: 'info'
      };
    }
    
    // Regular cancel
    const cancelResponse = "I understand. If you need help later, feel free to start a new chat. Is there anything else I can help you with?";
    await createMessage({
      sessionId,
      messageText: userMessage,
      sender: 'user'
    });
    await createMessage({
      sessionId,
      messageText: cancelResponse,
      sender: 'system'
    });
    
    return {
      message: cancelResponse,
      type: 'info'
    };
  }

  // Store user message (after off-topic/cancel checks pass)
  await createMessage({
    sessionId,
    messageText: userMessage,
    sender: 'user'
  });

  // ============================================
  // CRITICAL: Handle CONFIRMATION mode FIRST (before ANY other logic)
  // This prevents auto-submit when user says "no"
  // Check mode BEFORE updating state to ensure we have the correct mode
  // ============================================
  const currentMode = sessionState.conversationMode;
  if (ENABLE_LOGGING && currentMode === CONVERSATION_MODE.CONFIRMATION) {
    console.log('[AI Chat] User message in CONFIRMATION mode:', userMessage);
  }
  
  if (currentMode === CONVERSATION_MODE.CONFIRMATION) {
    const normalized = userMessage.toLowerCase().trim();
    
    // Check for clarification requests first (even in confirmation mode)
    const clarificationPatterns = [
      /(what do you mean|what do u mean|what.*ticket|what.*is.*ticket|what.*are.*you.*talking|what.*are.*u.*talking)/i,
      /(i don't understand|i dont understand|explain|can you explain)/i
    ];
    
    if (clarificationPatterns.some(pattern => pattern.test(normalized))) {
      // User is asking for clarification about the ticket/submission
      const response = "A support ticket is a request for help that I'll send to our IT support team. Based on the information you've provided, I can create a ticket so they can help you with your Outlook login issue. Would you like me to submit this ticket? (yes/no)";
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
    
    // Check for YES (confirmation patterns - can be standalone or start of sentence)
    // Also match variations like "yes sure u can", "yes u can", "yes go ahead", etc.
    const yesPattern = /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly|go ahead|submit)/i;
    const yesWithMorePattern = /(yes|yeah|yep|yup|sure).*(can|submit|go|proceed|do it|do that)/i;
    const canSubmitPattern = /(u can|you can|can u|can you).*(submit|go|proceed|do it)/i;
    const saidYesPattern = /(i said|i told|i mean).*(yes|sure|ok|okay|go ahead|submit)/i;
    
    if (yesPattern.test(normalized) || yesWithMorePattern.test(normalized) || canSubmitPattern.test(normalized) || saidYesPattern.test(normalized)) {
      // User confirmed, proceed with submission
      try {
        const result = await submitTicketHelper(sessionId, sessionState);
        await updateSessionState(sessionId, {
          conversationMode: CONVERSATION_MODE.INTAKE, // Reset mode
          submissionDeclined: false // Clear decline flag on successful submission
        });
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
    
    // Check for NO (decline patterns - can be standalone, start of sentence, or followed by more text)
    // IMPORTANT: Match "no" even if followed by other text like "no let me tell you more"
    const noPattern = /^(no|nope|nah|not really|incorrect|wrong|that's wrong|cancel)/i;
    if (noPattern.test(normalized)) {
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] User declined submission in confirmation mode');
      }
      
      // User declined submission - set flag to prevent auto-submit
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.INTAKE,
        submissionDeclined: true // CRITICAL: Track that user declined
      });
      
      // Reload state to get updated submissionDeclined flag
      sessionState = await loadSessionState(sessionId);
      
      const response = "No problem. What information would you like to update or add?";
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Submission declined, returning to intake mode');
      }
      
      return {
        message: response,
        type: 'info'
      };
    }
    
    // If in confirmation mode but response doesn't match yes/no, treat as answer and continue
    // (user might be providing additional info)
  }

  // Update session state with message and intent (after confirmation check)
  sessionState = await updateSessionState(sessionId, {
    message: {
      sender: 'user',
      message: userMessage,
      timestamp: new Date()
    },
    lastIntent: intent,
    conversationMode: sessionState.conversationMode === CONVERSATION_MODE.SECURITY_WARNING 
      ? CONVERSATION_MODE.INTAKE 
      : sessionState.conversationMode // Reset from security warning if user continues
  });

  // Compute missing fields BEFORE any AI call
  const missingFields = getMissingFields(sessionState);

  // If no missing fields, submit immediately (BUT respect submission_declined flag)
  if (missingFields.length === 0 && !sessionState.submissionDeclined) {
    // Show confirmation first if not already in confirmation mode
    if (sessionState.conversationMode !== CONVERSATION_MODE.CONFIRMATION) {
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      });
      
      const summary = buildSubmissionSummary(sessionState);
      const confirmationMessage = `${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] All fields collected, showing confirmation');
      }
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      };
    }
    // If already in confirmation mode and we reach here, user must have confirmed - submit
    // (This should not happen if confirmation handling above worked correctly)
  }

  // Handle SUBMIT_REQUEST intent - but require confirmation if not all fields collected
  if (intent === INTENT.SUBMIT_REQUEST || checkSubmissionKeywords(userMessage)) {
    const missingFields = getMissingFields(sessionState);
    const readyToSubmit = canSubmitTicketCategoryAware(sessionState);
    
    // If ready to submit, show confirmation first
    if (readyToSubmit) {
      // Enter confirmation mode and show summary
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      });
      
      const summary = buildSubmissionSummary(sessionState);
      const confirmationMessage = `${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      };
    } else {
      // Not ready, but user requested submission - show what's missing
      const missingList = missingFields.join(', ');
      const response = `I need a bit more information before I can submit your ticket. Still missing: ${missingList}. Would you like to continue providing this information, or submit with what we have so far?`;
      
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      
      return {
        message: response,
        type: 'info',
        readyToSubmit: false
      };
    }
  }
  
  // Handle CONFIRMATION intent (user responding yes/no to submission confirmation)
  // Also check if we're in confirmation mode even if intent wasn't classified as CONFIRMATION
  if (sessionState.conversationMode === CONVERSATION_MODE.CONFIRMATION) {
    const normalized = userMessage.toLowerCase().trim();
    
    // Check for YES (confirmation patterns - can be standalone or start of sentence)
    const yesPattern = /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly|go ahead|submit)/i;
    if (yesPattern.test(normalized)) {
      // User confirmed, proceed with submission
      try {
        const result = await submitTicketHelper(sessionId, sessionState);
        await updateSessionState(sessionId, {
          conversationMode: CONVERSATION_MODE.INTAKE, // Reset mode
          submissionDeclined: false // Clear decline flag on successful submission
        });
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
    
    // Check for NO (decline patterns - can be standalone, start of sentence, or followed by more text)
    const noPattern = /^(no|nope|nah|not really|incorrect|wrong|that's wrong|cancel|let me|wait|hold on)/i;
    if (noPattern.test(normalized)) {
      // User declined submission - set flag to prevent auto-submit
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.INTAKE,
        submissionDeclined: true // CRITICAL: Track that user declined
      });
      
      const response = "No problem. What information would you like to update or add?";
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      
      return {
        message: response,
        type: 'info'
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

  // Handle CLARIFICATION intent (user asking bot to clarify)
  if (intent === INTENT.CLARIFICATION) {
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.CLARIFICATION
    });
    
    const lastQuestion = sessionState.lastBotQuestion || 
      (sessionState.askedQuestions && sessionState.askedQuestions.length > 0
        ? sessionState.askedQuestions[sessionState.askedQuestions.length - 1]
        : null);
    
    const result = await handleClarification(sessionId, sessionState, userMessage, lastQuestion);
    
    // Reset to intake mode after clarification
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.INTAKE
    });
    
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
  
  // Handle CONFUSED intent
  if (intent === INTENT.CONFUSED) {
    const lastQuestion = sessionState.lastBotQuestion;
    const response = lastQuestion 
      ? `Let me rephrase that question more clearly: ${lastQuestion}\n\nOr if you'd like, I can ask about something else. What would be most helpful?`
      : "I'm here to help with your IT support issue. Could you tell me what problem you're experiencing?";
    
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
  
  // ============================================
  // CONVERSATION BRAIN: Reason about what to do next
  // This runs BEFORE field extraction and question generation
  // ============================================
  
  // Check if user is responding to a submission question (even if not in CONFIRMATION mode)
  // This handles cases where bot asks "would you like me to submit?" but mode is still INTAKE
  // Check both lastBotQuestion and the last system message from the conversation
  const lastQuestion = sessionState.lastBotQuestion || '';
  const lastSystemMessage = sessionState.messages && sessionState.messages.length > 0
    ? sessionState.messages.filter(m => m.sender === 'system').slice(-1)[0]?.message || ''
    : '';
  
  const isRespondingToSubmission = (lastQuestion.toLowerCase().includes('submit') || 
                                     lastQuestion.toLowerCase().includes('ticket')) ||
                                    (lastSystemMessage.toLowerCase().includes('submit') || 
                                     lastSystemMessage.toLowerCase().includes('ticket'));
  
  if (ENABLE_LOGGING && isRespondingToSubmission) {
    console.log('[AI Chat] Detected submission question response:', {
      lastBotQuestion: lastQuestion,
      lastSystemMessage: lastSystemMessage.substring(0, 50),
      userMessage: userMessage
    });
  }
  
  if (isRespondingToSubmission && !sessionState.submissionDeclined) {
    const normalized = userMessage.toLowerCase().trim();
    const yesPattern = /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly|go ahead|submit)/i;
    const yesWithMorePattern = /(yes|yeah|yep|yup|sure).*(can|submit|go|proceed|do it|do that)/i;
    const canSubmitPattern = /(u can|you can|can u|can you).*(submit|go|proceed|do it)/i;
    const saidYesPattern = /(i said|i told|i mean).*(yes|sure|ok|okay|go ahead|submit)/i;
    
    if (yesPattern.test(normalized) || yesWithMorePattern.test(normalized) || canSubmitPattern.test(normalized) || saidYesPattern.test(normalized)) {
      // User confirmed submission
      const readyToSubmit = canSubmitTicketCategoryAware(sessionState);
      if (readyToSubmit) {
        try {
          const result = await submitTicketHelper(sessionId, sessionState);
          await updateSessionState(sessionId, {
            conversationMode: CONVERSATION_MODE.INTAKE,
            submissionDeclined: false
          });
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
    }
  }
  
  // Skip conversation brain for special intents that were already handled
  const skipBrainIntents = [
    INTENT.GREETING,
    INTENT.FRUSTRATION,
    INTENT.CLARIFICATION,
    INTENT.CONFUSED,
    INTENT.OFF_TOPIC,
    INTENT.CANCEL
  ];
  
  let brainDecision = null;
  if (!skipBrainIntents.includes(intent) && sessionState.conversationMode !== CONVERSATION_MODE.CONFIRMATION) {
    try {
      brainDecision = await reasonAboutConversation(userMessage, sessionState, intent);
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Conversation Brain Decision:', brainDecision);
      }
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] Conversation brain error:', error.message);
      }
      // Continue with normal flow if brain fails
    }
  }
  
  // Handle brain decision: REDIRECT_OFF_TOPIC
  if (brainDecision && brainDecision.action === 'REDIRECT_OFF_TOPIC') {
    await createMessage({
      sessionId,
      messageText: brainDecision.questionToAsk || "I'm here to help with your IT support issue. Could you tell me about the technical problem you're experiencing?",
      sender: 'system'
    });
    
    return {
      message: brainDecision.questionToAsk || "I'm here to help with your IT support issue. Could you tell me about the technical problem you're experiencing?",
      type: 'redirect'
    };
  }
  
  // Handle brain decision: SUBMIT (but respect submission_declined flag)
  if (brainDecision && brainDecision.action === 'SUBMIT' && !sessionState.submissionDeclined) {
    // Show confirmation first if not already in confirmation mode
    if (sessionState.conversationMode !== CONVERSATION_MODE.CONFIRMATION) {
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      });
      
      const summary = buildSubmissionSummary(sessionState);
      const confirmationMessage = `${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      };
    }
  }
  
  // Handle brain decision: WAIT (don't ask anything, just acknowledge)
  if (brainDecision && brainDecision.action === 'WAIT') {
    // CRITICAL: Check if user is responding to a submission question
    // Even if not in CONFIRMATION mode, check if last question was about submission
    // Check both lastBotQuestion and the last system message
    const lastQuestion = sessionState.lastBotQuestion || '';
    const lastSystemMessage = sessionState.messages && sessionState.messages.length > 0
      ? sessionState.messages.filter(m => m.sender === 'system').slice(-1)[0]?.message || ''
      : '';
    
    const isSubmissionQuestion = (lastQuestion.toLowerCase().includes('submit') || 
                                  lastQuestion.toLowerCase().includes('ticket')) ||
                                 (lastSystemMessage.toLowerCase().includes('submit') || 
                                  lastSystemMessage.toLowerCase().includes('ticket'));
    
    if (ENABLE_LOGGING && isSubmissionQuestion) {
      console.log('[AI Chat] WAIT handler: Detected submission question response:', {
        lastBotQuestion: lastQuestion.substring(0, 50),
        lastSystemMessage: lastSystemMessage.substring(0, 50),
        userMessage: userMessage
      });
    }
    
    if (isSubmissionQuestion) {
      // User is responding to submission question - check for yes/no
      const normalized = userMessage.toLowerCase().trim();
      const yesPattern = /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|exactly|go ahead|submit)/i;
      const yesWithMorePattern = /(yes|yeah|yep|yup|sure).*(can|submit|go|proceed|do it|do that)/i;
      const canSubmitPattern = /(u can|you can|can u|can you).*(submit|go|proceed|do it)/i;
      const saidYesPattern = /(i said|i told|i mean).*(yes|sure|ok|okay|go ahead|submit)/i;
      
      if (yesPattern.test(normalized) || yesWithMorePattern.test(normalized) || canSubmitPattern.test(normalized) || saidYesPattern.test(normalized)) {
        // User confirmed submission
        const readyToSubmit = canSubmitTicketCategoryAware(sessionState);
        if (readyToSubmit) {
          try {
            const result = await submitTicketHelper(sessionId, sessionState);
            await updateSessionState(sessionId, {
              conversationMode: CONVERSATION_MODE.INTAKE,
              submissionDeclined: false
            });
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
      }
    }
    
    if (brainDecision.shouldAcknowledge && brainDecision.acknowledgment) {
      await createMessage({
        sessionId,
        messageText: brainDecision.acknowledgment,
        sender: 'system'
      });
      
      return {
        message: brainDecision.acknowledgment,
        type: 'acknowledgment'
      };
    }
    
    // If WAIT but no acknowledgment, check if we have all fields and offer submission
    const missingFields = getMissingFields(sessionState);
    const readyToSubmit = canSubmitTicketCategoryAware(sessionState) && !sessionState.submissionDeclined;
    
    if (readyToSubmit) {
      // User said "nothing more" but we have all fields - offer submission
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      });
      
      const summary = buildSubmissionSummary(sessionState);
      const confirmationMessage = `${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      };
    }
    
    // If not ready to submit, provide a helpful response
    const response = "I understand. Is there anything else you'd like to add, or would you like me to submit the ticket with the information we have so far?";
    await createMessage({
      sessionId,
      messageText: response,
      sender: 'system'
    });
    
    // CRITICAL: Update lastBotQuestion so we can detect submission responses
    await updateSessionState(sessionId, {
      lastBotQuestion: response,
      lastExpectedField: null
    });
    
    return {
      message: response,
      type: 'info'
    };
  }

  // ============================================
  // FIELD EXTRACTION: Extract multiple fields from user message
  // ============================================
  
  // Determine if we should extract fields based on brain decision
  const shouldExtract = !brainDecision || 
    ['ACKNOWLEDGE_AND_EXTRACT', 'EXTRACT_MULTIPLE', 'ACKNOWLEDGE_ONLY'].includes(brainDecision.action);
  
  let extracted = {};
  let aiResponse = null;
  let useFallback = false;
  let openaiLatency = 0;
  
  if (shouldExtract && isOpenAIAvailable()) {
    try {
      const aiStartTime = Date.now();
      // Pass conversation mode and last expected field for better context
      aiResponse = await processUserMessage(
        userMessage, 
        sessionState, 
        missingFields, 
        intent,
        sessionState.conversationMode,
        sessionState.lastExpectedField
      );
      openaiLatency = Date.now() - aiStartTime;
      extracted = aiResponse.extracted || {};
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[AI Chat] OpenAI extraction error:', error.message);
      }
      // Retry once
      try {
        const aiStartTime = Date.now();
        aiResponse = await processUserMessage(
          userMessage, 
          sessionState, 
          missingFields, 
          intent,
          sessionState.conversationMode,
          sessionState.lastExpectedField
        );
        openaiLatency = Date.now() - aiStartTime;
        extracted = aiResponse.extracted || {};
      } catch (retryError) {
        useFallback = true;
      }
    }
  } else if (!isOpenAIAvailable()) {
    useFallback = true;
  }

  // Fallback mode: simple text collection
  if (useFallback) {
    return await handleFallbackMode(sessionId, userMessage, sessionState, missingFields);
  }
  
  // Validate extracted fields (guardrails against garbage extraction)
  const validation = validateExtractedFields(extracted, userMessage, intent);
  extracted = validation.validated; // Use only validated fields
  
  // Safe merge: only fill null fields
  const mergedIntake = safeMergeIntake(sessionState.intake, extracted);

  // Track which fields were answered in this turn
  const newlyAnsweredFields = [];
  const confidenceUpdates = {};
  
  // Check which fields were filled by this extraction
  Object.keys(extracted).forEach(field => {
    if (extracted[field] !== null && extracted[field] !== undefined) {
      const wasNull = !sessionState.intake[field] || 
        (field === 'errorText' && (sessionState.intake[field] === null || sessionState.intake[field] === undefined));
      
      if (wasNull && mergedIntake[field]) {
        newlyAnsweredFields.push(field);
        // Use confidence from AI response if available, otherwise use intent confidence or default to medium
        confidenceUpdates[field] = (aiResponse && aiResponse.confidence) 
          ? aiResponse.confidence 
          : (intentConfidence || 'medium');
      }
    }
  });

  // Update session state with merged intake and answered fields tracking
  if (JSON.stringify(mergedIntake) !== JSON.stringify(sessionState.intake) || newlyAnsweredFields.length > 0) {
    sessionState = await updateSessionState(sessionId, {
      intake: mergedIntake,
      answeredFields: newlyAnsweredFields,
      confidenceByField: confidenceUpdates
    });
    
    if (ENABLE_LOGGING) {
      console.log('[AI Chat] Extracted and merged:', {
        extracted,
        mergedIntake,
        newlyAnsweredFields,
        previousIntake: sessionState.intake
      });
    }
  }

  // Recompute missing fields after merge
  const updatedMissingFields = getMissingFields(sessionState);

  // ============================================
  // ACKNOWLEDGMENT: Reflect what we understood
  // ============================================
  
  // If brain says we should acknowledge, do it now
  let acknowledgmentMessage = null;
  if (brainDecision && brainDecision.shouldAcknowledge && brainDecision.acknowledgment) {
    acknowledgmentMessage = brainDecision.acknowledgment;
  } else if (newlyAnsweredFields.length > 0 && userMessage.length > 15) {
    // Auto-generate acknowledgment if we extracted fields from a substantial message
    const extractedInfo = [];
    if (newlyAnsweredFields.includes('issue') && mergedIntake.issue) {
      extractedInfo.push(`you're experiencing: ${mergedIntake.issue}`);
    }
    if (newlyAnsweredFields.includes('urgency') && mergedIntake.urgency) {
      extractedInfo.push(`this is ${mergedIntake.urgency} priority`);
    }
    if (newlyAnsweredFields.includes('category') && mergedIntake.category) {
      extractedInfo.push(`this is a ${mergedIntake.category} issue`);
    }
    if (newlyAnsweredFields.includes('affectedSystem') && mergedIntake.affectedSystem) {
      extractedInfo.push(`affecting ${mergedIntake.affectedSystem}`);
    }
    
    if (extractedInfo.length > 0) {
      acknowledgmentMessage = `Thanks — I understand ${extractedInfo.join(', ')}.`;
    }
  }
  
  // Check if ready to submit (category-aware, backend decides)
  // BUT: Respect submission_declined flag
  const readyToSubmit = canSubmitTicketCategoryAware(sessionState) && !sessionState.submissionDeclined;

  if (readyToSubmit) {
    // Show confirmation before submitting (unless already in confirmation mode)
    if (sessionState.conversationMode !== CONVERSATION_MODE.CONFIRMATION) {
      await updateSessionState(sessionId, {
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      });
      
      const summary = buildSubmissionSummary(sessionState);
      const confirmationMessage = `${acknowledgmentMessage ? acknowledgmentMessage + '\n\n' : ''}${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Ready to submit, showing confirmation');
      }
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationMode: CONVERSATION_MODE.CONFIRMATION
      };
    }
  }

  // ============================================
  // QUESTION GENERATION: Ask next question (if needed)
  // ============================================
  
  // If brain says we should ask a question, use its suggestion or generate one
  let nextQuestion = null;
  let nextField = null;
  
  if (brainDecision && brainDecision.shouldAskQuestion) {
    if (brainDecision.questionToAsk) {
      // Use brain's suggested question
      nextQuestion = brainDecision.questionToAsk;
      // Try to infer field from question
      const fieldKeywords = {
        issue: ['issue', 'problem', 'what', 'describe'],
        category: ['category', 'type', 'kind'],
        urgency: ['urgency', 'urgent', 'priority'],
        affectedSystem: ['system', 'application', 'app', 'which'],
        errorText: ['error', 'message']
      };
      for (const [field, keywords] of Object.entries(fieldKeywords)) {
        if (keywords.some(kw => nextQuestion.toLowerCase().includes(kw))) {
          nextField = field;
          break;
        }
      }
    } else {
      // Generate question using traditional method
      const category = sessionState.intake.category || null;
      nextField = getNextField(updatedMissingFields, category);
      if (nextField) {
        nextQuestion = getNextQuestion(nextField, category, intent, sessionState.askedQuestions || []);
      }
    }
  } else if (updatedMissingFields.length > 0) {
    // No brain decision, but we have missing fields - generate question
    const category = sessionState.intake.category || null;
    nextField = getNextField(updatedMissingFields, category);
    if (nextField) {
      nextQuestion = getNextQuestion(nextField, category, intent, sessionState.askedQuestions || []);
    }
  }
  
  // If we have a question, prepare response
  if (nextQuestion) {
    // Prevent semantic repeats
    if (isSimilarQuestion(nextQuestion, sessionState.askedQuestions || [])) {
      if (ENABLE_LOGGING) {
        console.log('[AI Chat] Semantically similar question detected, generating alternative');
      }
      const category = sessionState.intake.category || null;
      nextQuestion = getNextQuestion(nextField, category, intent, sessionState.askedQuestions || []);
    }
    
    // Combine acknowledgment + question if both exist
    const fullMessage = acknowledgmentMessage 
      ? `${acknowledgmentMessage} ${nextQuestion}`
      : nextQuestion;
    
    // Store asked question and track conversation state
    await updateSessionState(sessionId, {
      askedQuestions: [nextQuestion],
      lastBotQuestion: nextQuestion,
      lastExpectedField: nextField,
      conversationMode: CONVERSATION_MODE.INTAKE
    });

    // Store system message
    await createMessage({
      sessionId,
      messageText: fullMessage,
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
        confidence: aiResponse?.confidence || 'unknown',
        acknowledged: !!acknowledgmentMessage
      });
    }

    return {
      message: fullMessage,
      type: 'question',
      readyToSubmit: false
    };
  } else if (acknowledgmentMessage) {
    // Only acknowledgment, no question
    await createMessage({
      sessionId,
      messageText: acknowledgmentMessage,
      sender: 'system'
    });
    
    return {
      message: acknowledgmentMessage,
      type: 'acknowledgment',
      readyToSubmit: false
    };
  }
  
  // Fallback: should not reach here, but handle gracefully
  // Check if we're in confirmation mode and user might be confused
  if (sessionState.conversationMode === CONVERSATION_MODE.CONFIRMATION) {
    const summary = buildSubmissionSummary(sessionState);
    const response = `${summary}\n\nShould I submit this ticket? (yes/no)`;
    
    await createMessage({
      sessionId,
      messageText: response,
      sender: 'system'
    });
    
    return {
      message: response,
      type: 'confirmation',
      readyToSubmit: true
    };
  }
  
  // Check if all fields collected but not in confirmation mode
  const finalMissingFields = getMissingFields(sessionState);
  if (finalMissingFields.length === 0 && !sessionState.submissionDeclined) {
    await updateSessionState(sessionId, {
      conversationMode: CONVERSATION_MODE.CONFIRMATION
    });
    
    const summary = buildSubmissionSummary(sessionState);
    const response = `${summary}\n\nShould I submit this ticket? (yes/no)`;
    
    await createMessage({
      sessionId,
      messageText: response,
      sender: 'system'
    });
    
    return {
      message: response,
      type: 'confirmation',
      readyToSubmit: true
    };
  }
  
  if (ENABLE_LOGGING) {
    console.warn('[AI Chat] No question or acknowledgment generated, using fallback');
  }
  
  const response = 'I understand. Is there anything else you\'d like to add, or would you like me to submit the ticket with the information we have so far?';
  await createMessage({
    sessionId,
    messageText: response,
    sender: 'system'
  });
  
  // CRITICAL: Update lastBotQuestion so we can detect submission responses
  await updateSessionState(sessionId, {
    lastBotQuestion: response,
    lastExpectedField: null
  });
  
  return {
    message: response,
    type: 'info',
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

    const nextField = missingFields[0] || 'issue';
    await updateSessionState(sessionId, {
      askedQuestions: [fallbackQuestion],
      lastBotQuestion: fallbackQuestion,
      lastExpectedField: nextField,
      conversationMode: CONVERSATION_MODE.INTAKE
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
    askedQuestions: [fallbackQuestion],
    lastBotQuestion: fallbackQuestion,
    lastExpectedField: firstMissing,
    conversationMode: CONVERSATION_MODE.INTAKE
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


