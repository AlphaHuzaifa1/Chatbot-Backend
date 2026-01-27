/**
 * UNIFIED CHAT SERVICE
 * 
 * Production-grade chat service using single LLM call architecture.
 * Implements strict state machine, full conversation history, and hard submission gates.
 */

import { processUserMessageUnified, isOpenAIAvailable } from './unifiedLLMService.js';
import {
  loadSessionState,
  updateSessionState,
  getMissingFields,
  markSessionSubmitted,
  createSessionState
} from './sessionStateService.js';
import { createMessage } from '../models/messageModel.js';
import { detectSensitiveData } from './sensitiveDataDetection.js';
import { submitTicket } from './ticketSubmissionService.js';
import { generateTicketSummary } from './openaiService.js';
import {
  CONVERSATION_STATE,
  canTransition,
  getNextState,
  isActionAllowed,
  isActionForbidden
} from './conversationStateMachine.js';

const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');
const MIN_REQUIRED_FIELDS = ['problem', 'urgency'];

/**
 * Check if user message contains explicit resume phrases
 */
const isExplicitResume = (userMessage) => {
  const normalized = userMessage.toLowerCase().trim();
  const resumePatterns = [
    /^(i'?m\s+back|i'm\s+ready|ready\s+now|continue|go\s+ahead|let'?s\s+continue|resume)/i,
    /^(ok|okay|yes|proceed|let'?s\s+go)/i
  ];
  return resumePatterns.some(pattern => pattern.test(normalized));
};

/**
 * Check if user message indicates they're still checking/verifying (should stay in WAITING)
 * These messages should be acknowledged gracefully without requiring explicit resume keywords
 */
const isStillChecking = (userMessage) => {
  const normalized = userMessage.toLowerCase().trim();
  const checkingPatterns = [
    /(let me check|checking|i'm checking|i am checking|will check|going to check)/i,
    /(let me verify|verifying|i'm verifying|will verify|going to verify)/i,
    /(let me look|looking|i'm looking|will look|going to look)/i,
    /(let me find|finding|i'm finding|will find|going to find)/i,
    /(will update|going to update|will share|will send|will provide)/i,
    /(give me a moment|one moment|just a sec|just a second|hold on)/i
  ];
  return checkingPatterns.some(pattern => pattern.test(normalized));
};

/**
 * Check if user message contains correction phrases
 */
const isCorrectionPhrase = (userMessage) => {
  const normalized = userMessage.toLowerCase().trim();
  const correctionPatterns = [
    /^(no\s+actually|that'?s\s+wrong|that'?s\s+not\s+right|incorrect|wrong)/i,
    /(the\s+error\s+is|update\s+the\s+error|i\s+meant|actually\s+it'?s|correction)/i,
    /(that'?s\s+not\s+correct|that'?s\s+incorrect)/i
  ];
  return correctionPatterns.some(pattern => pattern.test(normalized));
};

/**
 * Detect which field user is correcting (if any)
 */
const detectCorrectedField = (userMessage, llmFieldUpdates) => {
  const normalized = userMessage.toLowerCase();
  const fieldKeywords = {
    'errorText': ['error', 'error message', 'error text', 'message'],
    'problem': ['problem', 'issue', 'issue is'],
    'category': ['category', 'type'],
    'urgency': ['urgency', 'urgent', 'priority'],
    'affectedSystem': ['system', 'application', 'app', 'affected']
  };
  
  for (const [field, keywords] of Object.entries(fieldKeywords)) {
    if (keywords.some(keyword => normalized.includes(keyword))) {
      // Check if LLM extracted this field
      const mappedField = field === 'problem' ? 'issue' : field.toLowerCase();
      if (llmFieldUpdates && llmFieldUpdates[field] && llmFieldUpdates[field].value) {
        return mappedField;
      }
    }
  }
  return null;
};

/**
 * Check if all required fields meet confidence threshold
 */
const checkFieldConfidence = (intakeFields, confidenceByField, category) => {
  const requiredFields = category === 'password'
    ? ['problem', 'urgency', 'errorText']
    : ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];

  for (const field of requiredFields) {
    const value = intakeFields[field];
    const confidence = confidenceByField[field] || 0;

    // Field must exist and meet confidence threshold
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
 * Check if ticket can be submitted (hard gates)
 */
const canSubmitTicket = (sessionState) => {
  const { conversationState, intakeFields, confidenceByField, submissionApproved } = sessionState;

  // Gate 1: Must be in READY_TO_SUBMIT state
  if (conversationState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
    return { canSubmit: false, reason: 'Not in READY_TO_SUBMIT state' };
  }

  // Gate 2: User must have explicitly confirmed
  if (!submissionApproved) {
    return { canSubmit: false, reason: 'User has not confirmed submission' };
  }

  // Gate 3: All required fields must exist
  const category = intakeFields.category;
  const fieldCheck = checkFieldConfidence(intakeFields, confidenceByField, category);
  if (!fieldCheck.valid) {
    return { canSubmit: false, reason: fieldCheck.missingField ? `Missing field: ${fieldCheck.missingField}` : `Low confidence for ${fieldCheck.lowConfidenceField}` };
  }

  return { canSubmit: true };
};

/**
 * Generate ticket payload from session state
 */
const generateTicketPayload = async (sessionState, summaryData) => {
  const { intakeFields, userContext, sessionId } = sessionState;

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
    category: intakeFields.category || 'other',
    urgency: intakeFields.urgency || 'medium',
    impact: intakeFields.urgency === 'blocked' ? 'blocked' : 'single_user',
    summary: summaryData.summary,
    details: {
      problemDescription: intakeFields.problem || 'Not provided',
      urgency: intakeFields.urgency || 'Not specified',
      affectedSystem: intakeFields.affectedSystem || 'Not specified',
      errorMessage: intakeFields.errorText === 'no error provided' || !intakeFields.errorText
        ? 'No error message provided'
        : (intakeFields.errorText || 'Not provided'),
      additionalContext: null
    },
    keyDetails: summaryData.keyDetails || [],
    chatTranscript: sessionState.messageHistory || [],
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
    summaryData = await generateTicketSummary(sessionState.intakeFields, sessionState.userContext);
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Unified Chat] Summary generation error:', error.message);
    }
    // Fallback
    summaryData = {
      summary: sessionState.intakeFields.problem || 'Support request',
      keyDetails: [
        sessionState.intakeFields.problem ? `Issue: ${sessionState.intakeFields.problem}` : null,
        sessionState.intakeFields.urgency ? `Urgency: ${sessionState.intakeFields.urgency}` : null,
        sessionState.intakeFields.affectedSystem ? `Affected System: ${sessionState.intakeFields.affectedSystem}` : null
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
 * Process user message with unified architecture
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

  // Security check (before storing message)
  // Build context for context-aware security detection
  const lastBotMessage = sessionState.messages && sessionState.messages.length > 0
    ? sessionState.messages.filter(m => m.sender === 'system').slice(-1)[0]?.message || ''
    : '';
  
  const intakeContext = {
    errorText: sessionState.intake?.errorText,
    problem: sessionState.intake?.issue,
    category: sessionState.intake?.category
  };
  
  const securityContext = {
    conversationState: sessionState.conversationState || sessionState.conversationMode || CONVERSATION_STATE.INIT,
    lastBotMessage,
    intakeContext
  };
  
  const sensitiveCheck = detectSensitiveData(userMessage, securityContext);
  
  // Structured logging for security decision
  if (ENABLE_LOGGING) {
    console.log('[Unified Chat] Security check result:', JSON.stringify({
      sessionId,
      conversationState: securityContext.conversationState,
      detected: sensitiveCheck.detected,
      decision: sensitiveCheck.decision || 'UNKNOWN',
      patternType: sensitiveCheck.patternType || 'N/A',
      logMetadata: sensitiveCheck.logMetadata || {}
    }));
  }
  
  // Handle security decision outcomes
  if (sensitiveCheck.detected && sensitiveCheck.decision === 'BLOCK') {
    // High-risk detected - block immediately
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
    });

    if (ENABLE_LOGGING) {
      console.log('[Unified Chat] Security BLOCK triggered:', JSON.stringify({
        sessionId,
        previousState: securityContext.conversationState,
        newState: CONVERSATION_STATE.BLOCKED_SECURITY,
        patternType: sensitiveCheck.patternType
      }));
    }

    return {
      message: sensitiveCheck.message + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY,
      requiresAcknowledgment: true
    };
  } else if (sensitiveCheck.decision === 'SAFE') {
    // Safe intent-to-share detected (e.g., sharing error messages)
    // Allow processing to continue - do NOT block
    if (ENABLE_LOGGING) {
      console.log('[Unified Chat] Security SAFE decision - allowing processing:', JSON.stringify({
        sessionId,
        conversationState: securityContext.conversationState,
        reason: sensitiveCheck.logMetadata?.reason || 'Safe context detected'
      }));
    }
    // Continue with normal flow below (no early return)
  } else if (sensitiveCheck.detected && !sensitiveCheck.decision) {
    // Legacy format or unexpected state - default to blocking for safety
    if (ENABLE_LOGGING) {
      console.warn('[Unified Chat] Security check detected but no decision field - defaulting to BLOCK:', JSON.stringify({
        sessionId,
        detected: sensitiveCheck.detected,
        type: sensitiveCheck.type
      }));
    }
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
    });
    return {
      message: (sensitiveCheck.message || 'For security reasons, please do not share sensitive information.') + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY,
      requiresAcknowledgment: true
    };
  }
  // If decision === 'PASS' or 'SAFE', continue with normal processing

  // Handle security acknowledgment
  if (sessionState.conversationState === CONVERSATION_STATE.BLOCKED_SECURITY) {
    const normalized = userMessage.toLowerCase().trim();
    // More flexible acknowledgment pattern - handles typos and variations
    // Also check for negative statements and handle them appropriately
    const negativePattern = /(i\s*(did|do)\s*not|i\s*dont|i\s*don't|no\s*,?\s*i|not)\s*(understand|uderstand|undestand|understan)/i;
    
    if (negativePattern.test(normalized)) {
      // User says they don't understand - provide clarification
      const response = "I understand this might be confusing. For security reasons, we cannot accept passwords, PINs, codes, or tokens through this chat. This is to protect your account. You can simply type 'I understand' to continue, or if you have questions, I can help explain further.";
      await createMessage({
        sessionId,
        messageText: response,
        sender: 'system'
      });
      return {
        message: response,
        type: 'info',
        conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
      };
    }
    
    // Check for positive acknowledgment
    const acknowledgmentPattern = /^(i\s*(understand|uderstand|undestand|understan)|understood|got\s*it|ok|okay|i\s*(won'?t|will\s*not|get\s*it)|acknowledged|i\s*acknowledge)/i;
    
    // Also check if message contains acknowledgment even if not at start
    const hasAcknowledgment = acknowledgmentPattern.test(normalized) || 
                              /(i\s*(understand|uderstand|undestand|understan)|understood|got\s*it|i\s*get\s*it)/i.test(normalized);

    if (hasAcknowledgment) {
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.INTAKE
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
        conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
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

  // ============================================
  // HARD-LOCK: WAITING STATE ENFORCEMENT
  // ============================================
  if (sessionState.conversationState === CONVERSATION_STATE.WAITING) {
    // Check if user explicitly resumed
    if (isExplicitResume(userMessage)) {
      // User explicitly resumed - transition to INTAKE
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.INTAKE
      });
      // Continue with normal processing below
      sessionState = await loadSessionState(sessionId);
      
      if (ENABLE_LOGGING) {
        console.log('[Unified Chat] WAITING state: user explicitly resumed, transitioning to INTAKE:', JSON.stringify({
          sessionId,
          userMessage: userMessage.substring(0, 50)
        }));
      }
    } else if (isStillChecking(userMessage)) {
      // User is still checking/verifying - acknowledge gracefully and stay in WAITING
      // This provides human-like acknowledgment without requiring exact resume keywords
      const acknowledgmentResponse = "No problem, take your time. Let me know when you're ready to continue.";
      await createMessage({
        sessionId,
        messageText: userMessage,
        sender: 'user'
      });
      await createMessage({
        sessionId,
        messageText: acknowledgmentResponse,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[Unified Chat] WAITING state: user still checking, acknowledging:', JSON.stringify({
          sessionId,
          userMessage: userMessage.substring(0, 50),
          response: 'acknowledgment'
        }));
      }
      
      return {
        message: acknowledgmentResponse,
        type: 'waiting',
        conversationState: CONVERSATION_STATE.WAITING
      };
    } else {
      // Still waiting - ignore LLM flow_decision, do NOT extract fields, do NOT ask questions
      const waitingResponse = "I'm still waiting. When you're ready to continue, just let me know by saying 'I'm back', 'continue', or 'go ahead'.";
      await createMessage({
        sessionId,
        messageText: waitingResponse,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[Unified Chat] WAITING state lock: ignoring message, user must explicitly resume:', JSON.stringify({
          sessionId,
          userMessage: userMessage.substring(0, 50)
        }));
      }
      
      return {
        message: waitingResponse,
        type: 'waiting',
        conversationState: CONVERSATION_STATE.WAITING
      };
    }
  }

  // ============================================
  // HARD-LOCK: READY_TO_SUBMIT STATE ENFORCEMENT
  // ============================================
  if (sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT) {
    // Only allow specific intents: confirm_submit, deny_submit, add_more_info
    const allowedIntents = ['confirm_submit', 'deny_submit', 'add_more_info'];
    
    // We'll check intent after LLM call, but short-circuit field extraction
    // For now, continue to LLM to get intent, but we'll block extraction below
  }

  // Prepare session state for LLM
  const llmSessionState = {
    sessionId: sessionState.sessionId,
    conversationState: sessionState.conversationState || sessionState.conversationMode || CONVERSATION_STATE.INIT,
    intakeFields: {
      problem: sessionState.intake?.issue || null,
      category: sessionState.intake?.category || null,
      urgency: sessionState.intake?.urgency || null,
      affectedSystem: sessionState.intake?.affectedSystem || null,
      errorText: sessionState.intake?.errorText !== undefined ? sessionState.intake.errorText : null
    },
    confidenceByField: sessionState.confidenceByField || {},
    userContext: sessionState.userContext || {},
    submissionApproved: sessionState.submissionApproved || false,
    messageHistory: sessionState.messages || []
  };

  // Single LLM call - pass current user message explicitly
  if (!isOpenAIAvailable()) {
    throw new Error('OpenAI API not available');
  }

  let llmResponse;
  try {
    llmResponse = await processUserMessageUnified(llmSessionState, llmSessionState.messageHistory, userMessage);
  } catch (error) {
    if (ENABLE_LOGGING) {
      console.error('[Unified Chat] LLM error:', error.message);
    }
    throw new Error(`Failed to process message: ${error.message}`);
  }

  // ============================================
  // HARD-LOCK: READY_TO_SUBMIT - Block field extraction and questions
  // ============================================
  if (sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT) {
    const allowedIntents = ['confirm_submit', 'deny_submit', 'add_more_info'];
    
    if (!allowedIntents.includes(llmResponse.intent)) {
      // User provided info but we're in READY_TO_SUBMIT - show summary and ask for confirmation
      const summary = buildSubmissionSummary(llmSessionState.intakeFields);
      const confirmationMessage = `${summary}\n\nShould I submit this ticket? (yes/no)`;
      
      await createMessage({
        sessionId,
        messageText: confirmationMessage,
        sender: 'system'
      });
      
      if (ENABLE_LOGGING) {
        console.log('[Unified Chat] READY_TO_SUBMIT state lock: blocking field extraction, showing summary');
      }
      
      return {
        message: confirmationMessage,
        type: 'confirmation',
        readyToSubmit: true,
        conversationState: CONVERSATION_STATE.READY_TO_SUBMIT
      };
    }
  }

  // ============================================
  // FRUSTRATION FLOW OVERRIDE
  // ============================================
  if (llmResponse.intent === 'frustration') {
    // Do NOT ask new questions, do NOT extract fields
    // Show current summary and offer options
    const summary = buildSubmissionSummary(llmSessionState.intakeFields);
    const frustrationResponse = `I understand this is frustrating. Here's what I have so far:\n\n${summary}\n\nWhat would you like to do?\n- Submit as-is (type "yes" or "submit")\n- Let me correct something (tell me what to change)\n- Cancel (type "cancel")`;
    
    await createMessage({
      sessionId,
      messageText: frustrationResponse,
      sender: 'system'
    });
    
    if (ENABLE_LOGGING) {
      console.log('[Unified Chat] Frustration detected: pausing flow, showing summary and options');
    }
    
    // Update state but don't extract fields
    await updateSessionState(sessionId, {
      conversationState: sessionState.conversationState // Stay in current state
    });
    
    return {
      message: frustrationResponse,
      type: 'frustration_handling',
      conversationState: sessionState.conversationState
    };
  }

  // Handle security risk from LLM - only if LLM explicitly detects intent to share sensitive data
  // Don't block on just mentioning password-related issues
  if (llmResponse.intent === 'security_risk' && llmResponse.intent_confidence > 0.7) {
    // Double-check with backend detection to avoid false positives
    // Pass context for context-aware detection
    const lastBotMessage = sessionState.messages && sessionState.messages.length > 0
      ? sessionState.messages.filter(m => m.sender === 'system').slice(-1)[0]?.message || ''
      : '';
    const intakeContext = {
      errorText: sessionState.intake?.errorText,
      problem: sessionState.intake?.issue,
      category: sessionState.intake?.category
    };
    const backendCheck = detectSensitiveData(userMessage, {
      conversationState: sessionState.conversationState,
      lastBotMessage,
      intakeContext
    });
    
    if (backendCheck && backendCheck.detected && backendCheck.decision === 'BLOCK') {
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
      });

      if (ENABLE_LOGGING) {
        console.log('[Unified Chat] LLM security_risk intent confirmed by backend:', JSON.stringify({
          sessionId,
          llmIntent: 'security_risk',
          llmConfidence: llmResponse.intent_confidence,
          backendDecision: backendCheck.decision,
          patternType: backendCheck.patternType
        }));
      }

      return {
        message: backendCheck.message + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
        type: 'warning',
        sensitive: true,
        conversationState: CONVERSATION_STATE.BLOCKED_SECURITY,
        requiresAcknowledgment: true
      };
    }
    // If LLM says security_risk but backend doesn't detect it, trust the backend (more conservative)
    // Continue with normal processing
  }
  
  if (llmResponse.flow_decision === 'BLOCK' && llmResponse.intent_confidence > 0.8) {
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY
    });

    if (ENABLE_LOGGING) {
      console.log('[Unified Chat] LLM flow_decision BLOCK triggered:', JSON.stringify({
        sessionId,
        flowDecision: 'BLOCK',
        intentConfidence: llmResponse.intent_confidence,
        previousState: sessionState.conversationState,
        newState: CONVERSATION_STATE.BLOCKED_SECURITY
      }));
    }

    return {
      message: "For security reasons, please do not share passwords, PINs, codes, or tokens through this chat. If you need password reset assistance, I can guide you through the proper process. Please acknowledge that you understand by typing 'I understand'.",
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.BLOCKED_SECURITY,
      requiresAcknowledgment: true
    };
  }

  // Update intake fields (only missing ones, with confidence)
  // OR allow overwrite if user is explicitly correcting
  const updatedIntake = { ...llmSessionState.intakeFields };
  const updatedConfidence = { ...llmSessionState.confidenceByField };

  // Check if this is a correction (frustration, clarify, or correction phrases)
  const isCorrection = llmResponse.intent === 'frustration' || 
                       llmResponse.intent === 'clarify' || 
                       isCorrectionPhrase(userMessage);

  // Safely process field updates
  const fieldUpdates = llmResponse.field_updates || {};
  if (typeof fieldUpdates !== 'object' || fieldUpdates === null) {
    if (ENABLE_LOGGING) {
      console.warn('[Unified Chat] Invalid field_updates structure:', fieldUpdates);
    }
  } else {
    // Detect which field user is correcting (if correction)
    const correctedField = isCorrection ? detectCorrectedField(userMessage, fieldUpdates) : null;
    
    Object.entries(fieldUpdates).forEach(([field, update]) => {
      try {
        // Skip if update is null or not an object
        if (update === null || update === undefined || typeof update !== 'object') {
          return;
        }
        
        // Check if update has a valid value property
        if (!('value' in update) || !('confidence' in update)) {
          return;
        }
        
        // Check if update has a valid value
        if (update.value !== null && update.value !== undefined && update.value !== '') {
          // Map LLM field names to our field names
          let mappedField;
          if (field === 'problem') {
            mappedField = 'issue';
          } else if (field === 'affectedSystem') {
            mappedField = 'affectedSystem';
          } else {
            mappedField = field.toLowerCase();
          }
          
          const currentValue = updatedIntake[mappedField];
          const isMissing = currentValue === null || currentValue === undefined || currentValue === '';
          
          // Allow overwrite if: field is missing OR user is explicitly correcting this field
          const allowOverwrite = isMissing || (isCorrection && correctedField === mappedField);
          
          if (allowOverwrite) {
            const overwriteReason = isMissing ? 'missing' : 'user_corrected';
            updatedIntake[mappedField] = update.value;
            updatedConfidence[mappedField] = update.confidence || 0.5;
            
            if (ENABLE_LOGGING) {
              console.log(`[Unified Chat] Field ${mappedField} updated (reason: ${overwriteReason})`);
            }
          } else if (!isMissing && isCorrection) {
            if (ENABLE_LOGGING) {
              console.log(`[Unified Chat] Field ${mappedField} correction ignored (not the corrected field)`);
            }
          }
        }
      } catch (error) {
        if (ENABLE_LOGGING) {
          console.error(`[Unified Chat] Error processing field update for ${field}:`, error.message);
        }
        // Continue with other fields
      }
    });
  }

  // Determine next state based on LLM response
  let nextState = sessionState.conversationState;
  const previousState = sessionState.conversationState;
  
  // Map LLM intent to state machine intent
  const intentMap = {
    'provide_info': 'provide_info',
    'clarify': 'clarify',
    'interrupt_wait': 'interrupt_wait',
    'confirm_submit': 'confirm_submit',
    'deny_submit': 'deny_submit',
    'add_more_info': 'add_more_info',
    'frustration': 'provide_info', // Treat frustration as providing info (but handled separately above)
    'security_risk': 'security_risk',
    'idle': 'idle',
    'no_more_info': 'no_more_info'
  };

  const stateMachineIntent = intentMap[llmResponse.intent] || 'provide_info';

  // Handle flow decisions
  if (llmResponse.flow_decision === 'READY') {
    // Check if we can transition to READY_TO_SUBMIT
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    
    if (fieldCheck.valid) {
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    } else {
      // Not ready yet, stay in INTAKE
      nextState = CONVERSATION_STATE.INTAKE;
    }
  } else if (llmResponse.flow_decision === 'WAIT') {
    // Only transition to WAITING if not already in WAITING (enforced above)
    if (sessionState.conversationState !== CONVERSATION_STATE.WAITING) {
      nextState = CONVERSATION_STATE.WAITING;
    }
  } else if (llmResponse.flow_decision === 'SUBMIT') {
    // flow_decision === 'SUBMIT' is IGNORED - only confirm_submit intent can trigger submission
    // This is logged above in submission gate
    if (sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT && 
        llmResponse.intent === 'confirm_submit') {
      // Will handle submission below
    } else {
      // Not ready, transition to appropriate state
      nextState = CONVERSATION_STATE.INTAKE;
    }
  } else if (llmResponse.intent === 'deny_submit') {
    nextState = CONVERSATION_STATE.INTAKE;
  } else if (canTransition(sessionState.conversationState, stateMachineIntent)) {
    nextState = getNextState(sessionState.conversationState, stateMachineIntent);
  }

  // Log state transition with structured data
  if (ENABLE_LOGGING && nextState !== previousState) {
    console.log('[Unified Chat] State transition:', JSON.stringify({
      sessionId,
      previousState,
      nextState,
      intent: llmResponse.intent,
      intentConfidence: llmResponse.intent_confidence,
      flowDecision: llmResponse.flow_decision,
      transitionReason: nextState === CONVERSATION_STATE.READY_TO_SUBMIT ? 'all_fields_collected' :
                        nextState === CONVERSATION_STATE.WAITING ? 'user_paused' :
                        nextState === CONVERSATION_STATE.INTAKE ? 'collecting_info' :
                        'other'
    }));
  }

  // ============================================
  // SUBMISSION GATE: Only allow explicit confirm_submit intent
  // ============================================
  // LLM flow_decision MUST NEVER trigger submission without explicit user confirmation
  const wantsToSubmit = llmResponse.intent === 'confirm_submit';
  
  if (ENABLE_LOGGING && (llmResponse.flow_decision === 'SUBMIT' || llmResponse.intent === 'no_more_info')) {
    if (!wantsToSubmit) {
      console.log('[Unified Chat] Submission blocked: flow_decision or no_more_info cannot trigger submission without explicit confirm_submit intent');
    }
  }
  
  if (wantsToSubmit) {
    // Update state with latest intake first
    await updateSessionState(sessionId, {
      intake: updatedIntake,
      confidenceByField: updatedConfidence,
      conversationState: CONVERSATION_STATE.READY_TO_SUBMIT,
      submissionApproved: true
    });

    // Reload for submission check
    sessionState = await loadSessionState(sessionId);
    sessionState.intakeFields = updatedIntake;
    sessionState.confidenceByField = updatedConfidence;
    sessionState.conversationState = CONVERSATION_STATE.READY_TO_SUBMIT;

    // Check hard gates
    const submitCheck = canSubmitTicket(sessionState);
    if (!submitCheck.canSubmit) {
      if (ENABLE_LOGGING) {
        console.warn('[Unified Chat] Submission blocked:', submitCheck.reason);
      }
      // If not ready, show what's missing and ask for confirmation
      const category = updatedIntake.category;
      const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
      
      if (!fieldCheck.valid) {
        // Missing fields or low confidence - ask for more info
        const response = fieldCheck.missingField 
          ? `I need a bit more information before I can submit. I'm still missing: ${fieldCheck.missingField}. Could you provide that?`
          : `I need more information. The ${fieldCheck.lowConfidenceField} field has low confidence. Could you clarify?`;
        
        await createMessage({
          sessionId,
          messageText: response,
          sender: 'system'
        });
        
        await updateSessionState(sessionId, {
          conversationState: CONVERSATION_STATE.INTAKE
        });
        
        return {
          message: response,
          type: 'info'
        };
      }
      
      // If we have all fields but not in READY_TO_SUBMIT state, transition there
      await updateSessionState(sessionId, {
        conversationState: CONVERSATION_STATE.READY_TO_SUBMIT
      });
      
      const summary = buildSubmissionSummary(updatedIntake);
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
        conversationState: CONVERSATION_STATE.READY_TO_SUBMIT
      };
    }

    // All gates passed - submit ticket
    try {
      const result = await submitTicketHelper(sessionId, sessionState);
      return result;
    } catch (error) {
      if (ENABLE_LOGGING) {
        console.error('[Unified Chat] Submission error:', error.message);
      }
      return {
        message: 'There was an issue submitting your ticket. Please contact support directly.',
        type: 'error',
        error: error.message
      };
    }
  }

  // Update session state
  await updateSessionState(sessionId, {
    intake: updatedIntake,
    confidenceByField: updatedConfidence,
    conversationState: nextState,
    submissionApproved: llmResponse.intent === 'confirm_submit' ? true : 
                        llmResponse.intent === 'deny_submit' ? false : 
                        (sessionState.submissionApproved || false)
  });

  // Store system response
  await createMessage({
    sessionId,
    messageText: llmResponse.response,
    sender: 'system'
  });

  // If READY, show summary and ask for confirmation
  if (nextState === CONVERSATION_STATE.READY_TO_SUBMIT && 
      llmResponse.flow_decision === 'READY') {
    
    const summary = buildSubmissionSummary(updatedIntake);
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
      conversationState: CONVERSATION_STATE.READY_TO_SUBMIT
    };
  }

  if (ENABLE_LOGGING) {
    console.log('[Unified Chat] Response generated:', JSON.stringify({
      sessionId,
      intent: llmResponse.intent,
      intentConfidence: llmResponse.intent_confidence,
      flowDecision: llmResponse.flow_decision,
      nextState,
      previousState,
      submissionApproved: llmResponse.intent === 'confirm_submit',
      responseType: nextState === CONVERSATION_STATE.WAITING ? 'waiting' :
                    nextState === CONVERSATION_STATE.READY_TO_SUBMIT ? 'confirmation' :
                    'info',
      latency: `${Date.now() - startTime}ms`,
      fieldsUpdated: Object.keys(updatedIntake).filter(k => updatedIntake[k] !== llmSessionState.intakeFields[k]).length
    }));
  }

  return {
    message: llmResponse.response,
    type: nextState === CONVERSATION_STATE.WAITING ? 'waiting' :
          nextState === CONVERSATION_STATE.READY_TO_SUBMIT ? 'confirmation' :
          'info',
    conversationState: nextState
  };
};

/**
 * Build submission summary
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
  
  return `Here's what I understood:\n\n${summaryParts.join('\n')}`;
};

export default {
  processMessage
};

