/**
 * CONVERSATION CHAT SERVICE V2
 * 
 * Production-grade conversation-driven AI system.
 * 
 * Architecture:
 * 1. Security check (before storing message)
 * 2. Intent classification (semantic understanding)
 * 3. Conversation Brain (decides what to do)
 * 4. Semantic extraction (extracts fields)
 * 5. Smart probing (generates questions)
 * 6. State machine enforcement (backend-owned)
 * 7. Submission validation (backend-owned)
 * 
 * Key Principles:
 * - LLM is used as semantic interpreter, NOT decision-maker
 * - Backend enforces state transitions
 * - Conversation-first, fields second
 * - Memory with summarization
 * - Human-like responses
 */

import { loadSessionState, updateSessionState, getMissingFields, markSessionSubmitted } from './sessionStateService.js';
import { createMessage } from '../models/messageModel.js';
import { detectSensitiveData } from './sensitiveDataDetection.js';
import { submitTicket } from './ticketSubmissionService.js';
import { generateTicketSummary } from './openaiService.js';
import { classifyIntent, isIntentConfident, getFallbackIntent, INTENT } from './intentClassificationV2.js';
import { reasonAboutConversation } from './conversationBrainV2.js';
import { extractFields, filterByConfidence } from './semanticExtractionService.js';
import { generateProbingQuestion } from './smartProbingService.js';
import { buildConversationSummary, updateConversationSummary, getConversationContext } from './conversationMemoryService.js';
import {
  CONVERSATION_STATE,
  canTransition,
  getNextState,
  validateTransition,
  isActionAllowed,
  isActionForbidden
} from './conversationStateMachineV2.js';

const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');

/**
 * Check if all required fields meet confidence threshold
 * Based on PM requirements:
 * - Password category: problem, urgency, errorText (affectedSystem optional)
 * - Other categories: problem, category, urgency, affectedSystem, errorText
 */
const checkFieldConfidence = (intakeFields, confidenceByField, category) => {
  // If category is password, different requirements
  if (category === 'password') {
    const requiredFields = ['problem', 'urgency', 'errorText'];
    for (const field of requiredFields) {
      const value = intakeFields[field];
      const confidence = confidenceByField?.[field] || 0;

      if (value === null || value === undefined || value === '') {
        return { valid: false, missingField: field };
      }

      // For password category, be slightly more lenient with confidence
      const threshold = field === 'errorText' ? 0.5 : CONFIDENCE_THRESHOLD;
      if (confidence < threshold) {
        return { valid: false, lowConfidenceField: field, confidence };
      }
    }
    return { valid: true };
  }

  // For other categories, require all fields including category
  const requiredFields = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];
  for (const field of requiredFields) {
    const value = intakeFields[field];
    const confidence = confidenceByField?.[field] || 0;

    if (value === null || value === undefined || value === '') {
      return { valid: false, missingField: field };
    }

    if (confidence < CONFIDENCE_THRESHOLD) {
      return { valid: false, lowConfidenceField: field, confidence };
    }
  }

  return { valid: true };
};

/**
 * Check if ticket can be submitted (backend validation)
 */
const isReadyForSubmission = (sessionState) => {
  const { conversationState, intake, confidenceByField } = sessionState;

  // Must be in READY_TO_SUBMIT state
  if (conversationState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
    return { ready: false, reason: 'Not in READY_TO_SUBMIT state' };
  }

  // User must have explicitly confirmed
  if (!sessionState.submissionApproved) {
    return { ready: false, reason: 'User has not confirmed submission' };
  }

  // All required fields must exist with sufficient confidence
  const category = intake?.category;
  const fieldCheck = checkFieldConfidence(intake, confidenceByField || {}, category);
  
  if (!fieldCheck.valid) {
    return { 
      ready: false, 
      reason: fieldCheck.missingField 
        ? `Missing field: ${fieldCheck.missingField}` 
        : `Low confidence for ${fieldCheck.lowConfidenceField}` 
    };
  }

  return { ready: true };
};

/**
 * Generate ticket payload
 */
const generateTicketPayload = async (sessionState, summaryData) => {
  const { intake, userContext, sessionId } = sessionState;

  return {
    sessionId,
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
      problemDescription: intake.problem || 'Not provided',
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

/**
 * Submit ticket helper
 */
const submitTicketHelper = async (sessionId, sessionState) => {
  // Generate ticket summary
  let summaryData;
  try {
    summaryData = await generateTicketSummary(sessionState.intake, sessionState.userContext);
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Conversation Chat] Summary generation error:', error.message);
    }
    // Fallback
    summaryData = {
      summary: sessionState.intake.problem || 'Support request',
      keyDetails: [
        sessionState.intake.problem ? `Issue: ${sessionState.intake.problem}` : null,
        sessionState.intake.urgency ? `Urgency: ${sessionState.intake.urgency}` : null,
        sessionState.intake.affectedSystem ? `Affected System: ${sessionState.intake.affectedSystem}` : null
      ].filter(Boolean)
    };
  }

  // Generate ticket payload
  const ticketPayload = await generateTicketPayload(sessionState, summaryData);

  // Submit ticket
  const userId = null;
  const submissionResult = await submitTicket(ticketPayload, sessionId, userId);

  // Mark session as submitted
  await markSessionSubmitted(sessionId);
  await updateSessionState(sessionId, {
    conversationState: CONVERSATION_STATE.SUBMITTED
  });

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
 * Build submission summary for user confirmation
 */
const buildSubmissionSummary = (intakeFields) => {
  const summaryParts = [];
  
  if (intakeFields.problem) {
    summaryParts.push(`Issue: ${intakeFields.problem}`);
  }
  if (intakeFields.category) {
    summaryParts.push(`Category: ${intakeFields.category}`);
  }
  if (intakeFields.urgency) {
    summaryParts.push(`Urgency: ${intakeFields.urgency}`);
  }
  if (intakeFields.affectedSystem) {
    summaryParts.push(`Affected System: ${intakeFields.affectedSystem}`);
  }
  if (intakeFields.errorText && intakeFields.errorText !== 'no error provided') {
    summaryParts.push(`Error: ${intakeFields.errorText}`);
  }
  
  return `Here's what I understood:\n\n${summaryParts.join('\n')}\n\nShould I submit this ticket? (yes/no)`;
};

/**
 * Main message processing function
 */
export const processMessage = async (sessionId, userMessage) => {
  const startTime = Date.now();

  // Load session state
  let sessionState = await loadSessionState(sessionId);
  if (!sessionState) {
    throw new Error('Session not found');
  }

  // Check if already submitted
  if (sessionState.conversationState === CONVERSATION_STATE.SUBMITTED || sessionState.isSubmitted) {
    return {
      message: 'Your ticket has already been submitted. Please start a new session for additional support.',
      type: 'info',
      submitted: true
    };
  }

  // ============================================
  // STEP 1: SECURITY CHECK (before storing)
  // ============================================
  const sensitiveCheck = detectSensitiveData(userMessage);
  if (sensitiveCheck.detected) {
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.CLARIFYING // Use clarifying state for security warnings
    });

    return {
      message: sensitiveCheck.message + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.CLARIFYING,
      requiresAcknowledgment: true
    };
  }

  // Handle security acknowledgment
  if (sessionState.conversationState === CONVERSATION_STATE.CLARIFYING && 
      sessionState.lastBotQuestion?.includes('sensitive information')) {
    const normalized = userMessage.toLowerCase().trim();
    const acknowledgmentPattern = /^(i\s*(understand|uderstand|undestand|understan)|understood|got\s*it|ok|okay|i\s*(won'?t|will\s*not|get\s*it)|acknowledged|i\s*acknowledge)/i;
    
    if (acknowledgmentPattern.test(normalized)) {
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.PROBING
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
      return {
        message: "For security reasons, I cannot proceed until you acknowledge that you understand not to share sensitive information. Please type 'I understand' to continue.",
        type: 'warning',
        conversationState: CONVERSATION_STATE.CLARIFYING
      };
    }
  }

  // Store user message
  await createMessage({
    sessionId,
    messageText: userMessage,
    sender: 'user'
  });

  // Reload session state to get updated message history
  sessionState = await loadSessionState(sessionId);

  // Update conversation summary if needed
  sessionState = await updateConversationSummary(sessionState);

  // ============================================
  // STEP 2: INTENT CLASSIFICATION
  // ============================================
  const context = getConversationContext(sessionState);
  const lastBotMessage = sessionState.lastBotQuestion || '';
  const recentMessages = sessionState.messages?.slice(-8) || [];

  const intentResult = await classifyIntent(userMessage, {
    lastBotMessage,
    conversationState: sessionState.conversationState,
    recentMessages
  });

  let intent = intentResult.intent;
  let intentConfidence = intentResult.confidence;

  // Fallback if confidence too low
  if (!isIntentConfident(intentConfidence)) {
    intent = getFallbackIntent(userMessage, sessionState.conversationState);
    intentConfidence = 0.5;
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Using fallback intent:', intent);
    }
  }

  // ============================================
  // STEP 3: CONVERSATION BRAIN
  // ============================================
  const brainDecision = await reasonAboutConversation(
    userMessage,
    sessionState,
    intent,
    intentConfidence
  );

  // ============================================
  // STEP 4: SEMANTIC EXTRACTION
  // ============================================
  let extractedFields = {};
  let extractedConfidence = {};

  if (brainDecision.fieldsToExtract && brainDecision.fieldsToExtract.length > 0) {
    const extractionResult = await extractFields(userMessage, {
      currentIntake: sessionState.intake || {},
      fieldsToExtract: brainDecision.fieldsToExtract,
      lastBotQuestion: lastBotMessage,
      conversationSummary: context.type === 'summary' ? context.content : ''
    });

    // Filter by confidence
    const filtered = filterByConfidence(
      extractionResult.extracted,
      extractionResult.confidence,
      CONFIDENCE_THRESHOLD
    );

    extractedFields = filtered.extracted;
    extractedConfidence = filtered.confidence;
  }

  // ============================================
  // STEP 5: UPDATE INTAKE FIELDS
  // ============================================
  const updatedIntake = { ...(sessionState.intake || {}) };
  const updatedConfidence = { ...(sessionState.confidenceByField || {}) };

  // Only update missing fields
  for (const [field, value] of Object.entries(extractedFields)) {
    const currentValue = updatedIntake[field];
    if (currentValue === null || currentValue === undefined || currentValue === '') {
      updatedIntake[field] = value;
      updatedConfidence[field] = extractedConfidence[field] || 0.5;
    }
  }

  // Check if we have enough info after extraction (for password category, infer if not set)
  if (!updatedIntake.category && updatedIntake.problem) {
    // Try to infer category from problem description
    const problemLower = updatedIntake.problem.toLowerCase();
    if (problemLower.includes('password') || problemLower.includes('login') || problemLower.includes('reset') || problemLower.includes('account password') || problemLower.includes('cannot log in')) {
      updatedIntake.category = 'password';
      updatedConfidence.category = 0.8;
    }
  }
  
  // Also check user message for category hints
  if (!updatedIntake.category) {
    const userMessageLower = userMessage.toLowerCase();
    if (userMessageLower.includes('password') || userMessageLower.includes('reset') || userMessageLower.includes('account password')) {
      updatedIntake.category = 'password';
      updatedConfidence.category = 0.8;
    }
  }

  // After extraction, check if we have enough info to submit
  const category = updatedIntake.category;
  const fieldCheckAfterExtraction = checkFieldConfidence(updatedIntake, updatedConfidence, category);
  
  // If we have enough info and user provided substantial information, suggest showing summary
  if (fieldCheckAfterExtraction.valid && 
      brainDecision.action !== 'REDIRECT_OFF_TOPIC' &&
      brainDecision.action !== 'WAIT' &&
      intent !== INTENT.OFF_TOPIC &&
      intent !== INTENT.ASK_QUESTION &&
      sessionState.conversationState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
    // We have all required fields - suggest showing summary
    brainDecision.action = 'SHOW_SUMMARY';
    brainDecision.nextState = 'READY_TO_SUBMIT';
    brainDecision.shouldAskQuestion = false;
    brainDecision.shouldAcknowledge = true;
    brainDecision.acknowledgment = brainDecision.acknowledgment || "Thank you. I have all the information I need.";
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Enough info collected, moving to READY_TO_SUBMIT', {
        category,
        fields: Object.keys(updatedIntake).filter(k => updatedIntake[k]),
        confidence: updatedConfidence
      });
    }
  }

  // ============================================
  // STEP 6: STATE MACHINE ENFORCEMENT
  // ============================================
  let nextState = sessionState.conversationState;

  // Handle special intents
  if (intent === INTENT.OFF_TOPIC) {
    // Stay in current state, but redirect
    nextState = sessionState.conversationState;
  } else if (intent === INTENT.INTERRUPT_WAIT) {
    nextState = CONVERSATION_STATE.WAITING;
  } else if (intent === INTENT.CONFIRM_SUBMIT) {
    // Check if we have enough info first
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    
    if (fieldCheck.valid) {
      // We have enough info
      if (sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT) {
        // Already showed summary, user confirmed - submit immediately
        nextState = CONVERSATION_STATE.CONFIRMING_SUBMISSION;
      } else {
        // Not in READY_TO_SUBMIT yet - move there first to show summary
        nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
      }
    } else {
      // Not ready, stay in current state but acknowledge
      nextState = sessionState.conversationState;
    }
  } else if (intent === INTENT.DENY_SUBMIT) {
    nextState = CONVERSATION_STATE.PROBING;
  } else if (intent === INTENT.NO_MORE_INFO || intent === INTENT.FRUSTRATION) {
    // User says "nothing more" or "i have shared all details" - check if we have enough info
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    
    if (fieldCheck.valid) {
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
      // Override brain decision to show summary
      brainDecision.action = 'SHOW_SUMMARY';
      brainDecision.shouldAskQuestion = false;
    } else {
      // Not ready, stay in probing but acknowledge frustration
      nextState = CONVERSATION_STATE.PROBING;
    }
  } else if (brainDecision.nextState) {
    // Brain suggested a state - validate it
    const transitionValidation = validateTransition(
      sessionState.conversationState,
      intent,
      {
        hasMinimumFields: checkFieldConfidence(updatedIntake, updatedConfidence, updatedIntake.category).valid,
        allFieldsComplete: checkFieldConfidence(updatedIntake, updatedConfidence, updatedIntake.category).valid
      }
    );

    if (transitionValidation.valid && canTransition(sessionState.conversationState, intent)) {
      nextState = getNextState(sessionState.conversationState, intent);
    }
  }

  // ============================================
  // STEP 7: HANDLE SUBMISSION
  // ============================================
  if (nextState === CONVERSATION_STATE.CONFIRMING_SUBMISSION) {
    // Update state first with latest intake
    await updateSessionState(sessionId, {
      intake: updatedIntake,
      confidenceByField: updatedConfidence,
      conversationState: CONVERSATION_STATE.READY_TO_SUBMIT,
      submissionApproved: true
    });

    // Reload for submission check
    sessionState = await loadSessionState(sessionId);
    sessionState.intake = updatedIntake;
    sessionState.confidenceByField = updatedConfidence;
    sessionState.conversationState = CONVERSATION_STATE.READY_TO_SUBMIT;
    sessionState.submissionApproved = true;

    // Check backend validation
    const submitCheck = isReadyForSubmission(sessionState);
    if (submitCheck.ready) {
      try {
        if (ENABLE_LOGGING) {
          console.log('[Conversation Chat] Submitting ticket with fields:', {
            category: updatedIntake.category,
            problem: updatedIntake.problem,
            urgency: updatedIntake.urgency,
            errorText: updatedIntake.errorText
          });
        }
        const result = await submitTicketHelper(sessionId, sessionState);
        return result;
      } catch (error) {
        if (ENABLE_LOGGING) {
          console.error('[Conversation Chat] Submission error:', error.message);
        }
        return {
          message: 'There was an issue submitting your ticket. Please contact support directly.',
          type: 'error',
          error: error.message
        };
      }
    } else {
      // Not ready, show what's missing
      const category = updatedIntake.category;
      const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
      
      const response = fieldCheck.missingField 
        ? `I need a bit more information before I can submit. I'm still missing: ${fieldCheck.missingField}. Could you provide that?`
        : `I need more information. The ${fieldCheck.lowConfidenceField} field has low confidence. Could you clarify?`;
      
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.PROBING
      });
      
      return {
        message: response,
        type: 'info'
      };
    }
  }

  // ============================================
  // STEP 8: GENERATE RESPONSE
  // ============================================
  let responseMessage = '';

  // Handle special states
  if (nextState === CONVERSATION_STATE.WAITING) {
    responseMessage = brainDecision.acknowledgment || "No problem, take your time. Just let me know when you're ready to continue.";
  } else if (nextState === CONVERSATION_STATE.READY_TO_SUBMIT || brainDecision.action === 'SHOW_SUMMARY') {
    const summary = buildSubmissionSummary(updatedIntake);
    responseMessage = summary;
    // Ensure we're in READY_TO_SUBMIT state
    if (nextState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    }
  } else if (brainDecision.action === 'REDIRECT_OFF_TOPIC') {
    // Handle off-topic redirect
    responseMessage = brainDecision.acknowledgment || "I'm here to help with IT support issues. What technical problem are you experiencing?";
  } else if (nextState === CONVERSATION_STATE.READY_TO_SUBMIT && intent === INTENT.FRUSTRATION) {
    // User frustrated and we have enough info - show summary
    const summary = buildSubmissionSummary(updatedIntake);
    responseMessage = summary;
  } else {
    // Build response: acknowledgment + question
    const parts = [];
    
    if (brainDecision.shouldAcknowledge && brainDecision.acknowledgment) {
      parts.push(brainDecision.acknowledgment);
    }

    // Don't ask questions if we're ready to submit or if user is frustrated and we have enough info
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    const shouldNotAsk = fieldCheck.valid || (intent === INTENT.FRUSTRATION && fieldCheck.valid);

    if (brainDecision.shouldAskQuestion && !shouldNotAsk && brainDecision.questionToAsk) {
      parts.push(brainDecision.questionToAsk);
    } else if (brainDecision.shouldAskQuestion && !shouldNotAsk) {
      // Generate probing question
      const missingFields = getMissingFields({ intake: updatedIntake });
      if (missingFields.length > 0) {
        const question = await generateProbingQuestion(
          sessionState,
          missingFields,
          userMessage,
          brainDecision.acknowledgment
        );
        if (question) {
          parts.push(question);
        }
      }
    }

    responseMessage = parts.join(' ') || brainDecision.acknowledgment || "I understand. Could you tell me more about the issue?";
  }

  // ============================================
  // STEP 9: UPDATE SESSION STATE
  // ============================================
  await updateSessionState(sessionId, {
    intake: updatedIntake,
    confidenceByField: updatedConfidence,
    conversationState: nextState,
    lastBotQuestion: responseMessage,
    lastExpectedField: brainDecision.fieldsToExtract?.[0] || null,
    submissionApproved: intent === INTENT.CONFIRM_SUBMIT ? true : 
                        intent === INTENT.DENY_SUBMIT ? false : 
                        (sessionState.submissionApproved || false)
  });

  // Store system response
  await createMessage({
    sessionId,
    messageText: responseMessage,
    sender: 'system'
  });

  if (ENABLE_LOGGING) {
    console.log('[Conversation Chat] Response:', {
      intent,
      intentConfidence,
      action: brainDecision.action,
      nextState,
      fieldsExtracted: Object.keys(extractedFields),
      latency: `${Date.now() - startTime}ms`
    });
  }

  return {
    message: responseMessage,
    type: nextState === CONVERSATION_STATE.WAITING ? 'waiting' :
          nextState === CONVERSATION_STATE.READY_TO_SUBMIT ? 'confirmation' :
          'info',
    conversationState: nextState
  };
};

export default {
  processMessage
};

