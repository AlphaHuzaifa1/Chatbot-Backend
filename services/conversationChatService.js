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
import { getNextField } from './questionGenerationService.js';
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
  // Normalize field names: check both 'problem' and 'issue' for backward compatibility
  const problemValue = intakeFields.problem || intakeFields.issue;
  
  // If category is password, different requirements
  if (category === 'password') {
    const requiredFields = ['problem', 'urgency', 'errorText'];
    for (const field of requiredFields) {
      // Special handling for problem field
      const value = field === 'problem' ? problemValue : intakeFields[field];
      const confidence = confidenceByField?.[field] || confidenceByField?.[field === 'problem' ? 'issue' : field] || 0;

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
    // Special handling for problem field
    const value = field === 'problem' ? problemValue : intakeFields[field];
    const confidence = confidenceByField?.[field] || confidenceByField?.[field === 'problem' ? 'issue' : field] || 0;

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
  
  // Check both 'problem' and 'issue' for backward compatibility
  const problemValue = intakeFields.problem || intakeFields.issue;
  if (problemValue) {
    summaryParts.push(`Issue: ${problemValue}`);
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
  // FIX 2: Pass conversation context into security detection
  // This prevents false-positive blocks when user says "I will share error message"
  // Context allows safe-sharing detection to evaluate if bot requested error details
  const securityContext = {
    conversationState: sessionState.conversationState || sessionState.conversationMode || CONVERSATION_STATE.INIT,
    lastBotMessage: sessionState.lastBotQuestion || '',
    lastExpectedField: sessionState.lastExpectedField || null,
    intakeContext: {
      errorText: sessionState.intake?.errorText,
      problem: sessionState.intake?.problem,
      category: sessionState.intake?.category
    }
  };
  
  const sensitiveCheck = detectSensitiveData(userMessage, securityContext);
  if (sensitiveCheck.detected && sensitiveCheck.decision === 'BLOCK') {
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.CLARIFYING // Use clarifying state for security warnings
    });

    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Security BLOCK triggered:', JSON.stringify({
        sessionId,
        previousState: securityContext.conversationState,
        newState: CONVERSATION_STATE.CLARIFYING,
        patternType: sensitiveCheck.patternType,
        hasCredentialKeywords: sensitiveCheck.logMetadata?.hasCredentialKeywords,
        contextIndicatesSafeSharing: sensitiveCheck.logMetadata?.contextIndicatesSafeSharing
      }));
    }

    return {
      message: sensitiveCheck.message + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.CLARIFYING,
      requiresAcknowledgment: true
    };
  } else if (sensitiveCheck.decision === 'SAFE') {
    // FIX 2: Safe intent-to-share detected (e.g., sharing error messages)
    // Allow processing to continue - do NOT block
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Security SAFE decision - allowing processing:', JSON.stringify({
        sessionId,
        conversationState: securityContext.conversationState,
        reason: sensitiveCheck.logMetadata?.reason || 'Safe context detected'
      }));
    }
    // Continue with normal flow below (no early return)
  } else if (sensitiveCheck.detected && !sensitiveCheck.decision) {
    // Legacy format or unexpected state - default to blocking for safety
    if (ENABLE_LOGGING) {
      console.warn('[Conversation Chat] Security check detected but no decision field - defaulting to BLOCK:', JSON.stringify({
        sessionId,
        detected: sensitiveCheck.detected,
        type: sensitiveCheck.type
      }));
    }
    await updateSessionState(sessionId, {
      conversationState: CONVERSATION_STATE.CLARIFYING
    });
    return {
      message: (sensitiveCheck.message || 'For security reasons, please do not share sensitive information.') + '\n\nPlease acknowledge that you understand and won\'t share sensitive information. Type "I understand" to continue.',
      type: 'warning',
      sensitive: true,
      conversationState: CONVERSATION_STATE.CLARIFYING,
      requiresAcknowledgment: true
    };
  }
  // If decision === 'PASS' or 'SAFE', continue with normal processing

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

  // FIX 3: Make READY_TO_SUBMIT a protected state
  // Once all fields are valid and we're in READY_TO_SUBMIT, don't re-extract unless
  // user explicitly indicates a correction (e.g., "change", "actually", "that's wrong")
  const isInReadyState = sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT;
  const currentFieldCheck = checkFieldConfidence(
    sessionState.intake || {}, 
    sessionState.confidenceByField || {}, 
    sessionState.intake?.category
  );
  const isReadyStateStable = isInReadyState && currentFieldCheck.valid;
  
  // Check if user indicates correction or wants to provide more information
  // Enhanced to detect natural language correction patterns
  const correctionPatterns = [
    // Explicit corrections
    /(change|actually|that'?s\s+wrong|that'?s\s+not\s+right|incorrect|update|correct|fix|not\s+added|missing|you\s+forgot|you\s+have\s+not|you\s+didn'?t|wrong|that'?s\s+not|that'?s\s+incorrect|you\s+have\s+not\s+updated|not\s+updated|didn'?t\s+update|haven'?t\s+updated)/i,
    // Natural language corrections: "its not X, it is Y" or "it's not X, it's Y"
    /(it'?s\s+not|its\s+not|is\s+not|not\s+my|not\s+the).*?(it'?s|its|it\s+is|is|my|the)/i,
    // Direct instructions: "make it X", "set it to X", "change it to X"
    /(make|set|change|update|correct)\s+(it|its|the|this|that)\s+(to|as|to\s+be)\s+/i,
    // Contradictions: "not X but Y" or "not X, Y instead"
    /(not\s+[^,]+(?:,|but)\s+[^,]+)/i,
    // Field-specific corrections: "urgency is X", "affected system is X" (when contradicting existing)
    /(urgency|affected\s+system|system|account)\s+(is|should\s+be|needs?\s+to\s+be|must\s+be)\s+/i
  ];
  const indicatesCorrection = correctionPatterns.some(pattern => pattern.test(userMessage));
  
  const userWantsToProvideMore = intent === INTENT.INTERRUPT_WAIT || 
                                  intent === INTENT.ADD_MORE_INFO ||
                                  /(let\s+me\s+tell\s+you\s+more|i\s+need\s+to\s+(add|tell|share|provide)|wait\s+let\s+me|hold\s+on\s+let\s+me|i\s+want\s+to\s+(add|tell|share|provide)|need\s+to\s+add|want\s+to\s+add)/i.test(userMessage);
  
  // CRITICAL: If user was in WAITING state, they explicitly paused to provide more info
  // When they provide info after WAITING, we should allow updates to existing fields
  const wasInWaitingState = sessionState.conversationState === CONVERSATION_STATE.WAITING;
  const userProvidingInfoAfterWait = wasInWaitingState && (intent === INTENT.PROVIDE_INFO || intent === INTENT.FRUSTRATION || intent === INTENT.ADD_MORE_INFO);
  
  // Detect user complaints about information not being updated
  const userComplainingAboutUpdate = /(you\s+have\s+not|you\s+didn'?t|haven'?t|not\s+updated|didn'?t\s+update|you\s+missed|you\s+forgot|not\s+added|missing|you\s+have\s+not\s+updated|haven'?t\s+updated|you\s+didn'?t\s+add|what\s+are\s+you\s+doing)/i.test(userMessage);
  
  // Detect explicit field updates: "make urgency low", "affected system is gmail"
  const userExplicitlyUpdatingField = /(make|set|change|update|correct|its|it'?s|is|should\s+be)\s+(urgency|affected\s+system|system|account|category|error|problem)\s+/i.test(userMessage);
  
  // Determine fields to extract based on state protection and forced extraction rules
  let fieldsToExtract = brainDecision.fieldsToExtract;
  
  // CRITICAL FIX: Handle case where brain returns extracted values as object instead of array of field names
  // If brain returns an object with values, use those values directly and skip re-extraction
  let brainExtractedValues = null;
  if (fieldsToExtract && typeof fieldsToExtract === 'object' && !Array.isArray(fieldsToExtract)) {
    // Brain returned extracted values as object - use them directly
    brainExtractedValues = fieldsToExtract;
    // Convert to array of field names for extraction (but we'll use brain values instead)
    fieldsToExtract = Object.keys(fieldsToExtract);
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Brain returned extracted values - using directly:', {
        sessionId,
        brainExtractedValues,
        fieldNames: fieldsToExtract
      });
    }
  }
  
  // CRITICAL: If user is complaining about updates not being applied, force extraction
  if (userComplainingAboutUpdate || userExplicitlyUpdatingField) {
    // User says info wasn't updated or explicitly updating a field - extract all fields from their message
    fieldsToExtract = ['problem', 'category', 'urgency', 'affectedSystem', 'errorText'];
    brainExtractedValues = null; // Force re-extraction
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] User correction/explicit update detected - forcing extraction:', {
        sessionId,
        userMessage: userMessage.substring(0, 100),
        reason: userComplainingAboutUpdate ? 'User indicated information was not updated' : 'User explicitly updating field',
        indicatesCorrection,
        userExplicitlyUpdatingField
      });
    }
  } else if (isReadyStateStable && !indicatesCorrection && !userWantsToProvideMore && !userProvidingInfoAfterWait && !userExplicitlyUpdatingField) {
    // FIX 3: Protected state: Skip extraction, don't re-probe, maintain READY_TO_SUBMIT
    // Only allow extraction if user explicitly indicates correction, wants to provide more info, explicitly updates field, or is providing info after WAITING
    fieldsToExtract = [];
    brainExtractedValues = null;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] READY_TO_SUBMIT protected - skipping extraction:', {
        sessionId,
        reason: 'All fields valid, user did not indicate correction, want to provide more info, explicitly update field, or provide info after WAITING',
        userMessage: userMessage.substring(0, 50)
      });
    }
  } else if ((!fieldsToExtract || fieldsToExtract.length === 0) && 
             intent === INTENT.PROVIDE_INFO && 
             sessionState.conversationState === CONVERSATION_STATE.PROBING &&
             sessionState.lastExpectedField) {
    // STEP 3: Make forced extraction deterministic
    // Rule: If intent === PROVIDE_INFO AND conversation state === PROBING AND lastExpectedField exists
    // → extraction must run, regardless of brain action
    // This ensures user answers are never ignored when they're responding to a probing question
    fieldsToExtract = [sessionState.lastExpectedField];
    brainExtractedValues = null; // Force re-extraction
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] FORCING extraction for lastExpectedField (deterministic):', {
        lastExpectedField: sessionState.lastExpectedField,
        reason: 'User providing info in PROBING state - extraction required regardless of brain action',
        intent: intent,
        conversationState: sessionState.conversationState,
        brainAction: brainDecision.action,
        brainFieldsToExtract: brainDecision.fieldsToExtract
      });
    }
  }

  // Use brain-extracted values if available, otherwise run semantic extraction
  if (brainExtractedValues) {
    // Brain already extracted values - use them directly with high confidence
    extractedFields = {};
    extractedConfidence = {};
    
    // Map brain field names to our field names
    // Note: We use 'problem' internally but database uses 'issue' - we'll handle both
    const fieldMapping = {
      'problem': 'problem',
      'issue': 'problem', // Map 'issue' to 'problem' for consistency
      'category': 'category',
      'urgency': 'urgency',
      'affectedSystem': 'affectedSystem',
      'errorText': 'errorText'
    };
    
    // Normalize urgency values
    const normalizeUrgency = (urgency) => {
      if (!urgency) return null;
      const u = urgency.toLowerCase().trim();
      if (u.includes('urgent') || u.includes('very urgent') || u === 'urgent') return 'high';
      if (u.includes('blocked') || u.includes('cannot') || u.includes("can't")) return 'blocked';
      if (u === 'high' || u === 'medium' || u === 'low' || u === 'blocked') return u;
      return 'high'; // Default to high for urgent-sounding values
    };
    
    // Normalize category values
    const normalizeCategory = (category) => {
      if (!category) return null;
      const c = category.toLowerCase().trim();
      if (c.includes('email') || c.includes('o365') || c.includes('outlook') || c.includes('mail')) return 'email';
      if (c.includes('password') || c.includes('login') || c.includes('sign in')) return 'password';
      if (c === 'password' || c === 'hardware' || c === 'software' || c === 'network' || c === 'email' || c === 'other') return c;
      return 'other'; // Default to other if unclear
    };
    
    for (const [brainField, value] of Object.entries(brainExtractedValues)) {
      const mappedField = fieldMapping[brainField] || brainField;
      if (value !== null && value !== undefined && value !== '') {
        let normalizedValue = value;
        
        // Normalize specific fields
        if (mappedField === 'urgency') {
          normalizedValue = normalizeUrgency(value);
        } else if (mappedField === 'category') {
          normalizedValue = normalizeCategory(value);
        }
        
        extractedFields[mappedField] = normalizedValue;
        // Set high confidence for brain-extracted values
        extractedConfidence[mappedField] = 0.85;
      }
    }
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Using brain-extracted values:', {
        sessionId,
        extractedFields,
        extractedConfidence
      });
    }
  } else if (fieldsToExtract && Array.isArray(fieldsToExtract) && fieldsToExtract.length > 0) {
    // Run semantic extraction
    const extractionResult = await extractFields(userMessage, {
      currentIntake: sessionState.intake || {},
      fieldsToExtract: fieldsToExtract,
      lastBotQuestion: lastBotMessage,
      conversationSummary: context.type === 'summary' ? context.content : '',
      lastExpectedField: sessionState.lastExpectedField || null
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
  // STEP 5: UPDATE INTAKE FIELDS (OPTIMIZED)
  // ============================================
  const updatedIntake = { ...(sessionState.intake || {}) };
  const updatedConfidence = { ...(sessionState.confidenceByField || {}) };

  /**
   * Field-specific update logic with confidence-aware merging
   * Each field has specific rules for when and how to update
   * Note: Uses closure variables indicatesCorrection, userProvidingInfoAfterWait, userWantsToProvideMore, userComplainingAboutUpdate, userMessage, sessionState
   */
  const updateFieldWithRules = (field, newValue, newConfidence, currentValue, currentConfidence, userIntent) => {
    const isMissing = currentValue === null || currentValue === undefined || currentValue === '';
    const currentConf = currentConfidence || 0;
    const newConf = newConfidence || 0.5;
    const userMessageLower = userMessage.toLowerCase();
    
    // Intent-aware: Check if this field matches what the user is currently answering
    const isExpectedField = sessionState.lastExpectedField === field;
    
    // Check if user message contradicts existing value (e.g., "its not X, it is Y")
    const contradictsExisting = !isMissing && currentValue && (
      userMessageLower.includes('not') && (
        userMessageLower.includes(currentValue.toLowerCase().substring(0, Math.min(10, currentValue.length))) ||
        currentValue.toLowerCase().includes(userMessageLower.split('not')[1]?.trim().substring(0, 10))
      )
    );
    
    const isExplicitCorrection = indicatesCorrection && (
      userMessageLower.includes(field.toLowerCase()) ||
      userMessageLower.includes('category') && field === 'category' ||
      userMessageLower.includes('urgency') && field === 'urgency' ||
      userMessageLower.includes('error') && field === 'errorText' ||
      userMessageLower.includes('problem') && field === 'problem' ||
      userMessageLower.includes('system') && field === 'affectedSystem' ||
      userMessageLower.includes('account') && field === 'affectedSystem'
    ) || contradictsExisting;

    // Field-specific update rules
    switch (field) {
      case 'errorText':
        // Replace if: missing, explicit correction, more detailed, or user providing after wait
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        if (isExplicitCorrection || indicatesCorrection || userComplainingAboutUpdate) {
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly corrected error message' };
        }
        if (userProvidingInfoAfterWait || userWantsToProvideMore) {
          // CRITICAL: When user provides info after WAITING, trust their new error message
          // They explicitly paused to get the correct error message, so replace it
          const isDifferent = newValue.toLowerCase().trim() !== currentValue.toLowerCase().trim();
          if (isDifferent) {
            // Accept new error message if it's different, even if shorter
            // User went to check the exact error, so this is likely more accurate
            return { shouldUpdate: true, newValue, newConf, reason: 'New error message provided after wait - user checked exact message' };
          } else {
            // Even if same, if user provided after wait, they're confirming it - update confidence
            return { shouldUpdate: true, newValue, newConf: Math.max(newConf, currentConf), reason: 'User confirmed error message after checking' };
          }
        }
        // Don't replace if new confidence is significantly lower than existing (unless user is correcting)
        if (newConf < currentConf - 0.2 && !indicatesCorrection && !userProvidingInfoAfterWait) {
          return { shouldUpdate: false, reason: 'New confidence too low compared to existing' };
        }
        // Replace if new value is more detailed (longer and different)
        if (newValue.length > currentValue.length && 
            newValue.toLowerCase() !== currentValue.toLowerCase()) {
          return { shouldUpdate: true, newValue, newConf, reason: 'New error message is more detailed' };
        }
        return { shouldUpdate: false, reason: 'Existing error message preserved' };

      case 'problem':
        // Append/merge if: missing, explicit correction, or user providing additional info
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        if (isExplicitCorrection || indicatesCorrection) {
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly corrected problem description' };
        }
        if (userProvidingInfoAfterWait || userWantsToProvideMore || isExpectedField) {
          // Merge: append new information if it adds context
          const currentLower = currentValue.toLowerCase();
          const newLower = newValue.toLowerCase();
          
          // If new value contains significant new information, merge it
          const significantNewInfo = !currentLower.includes(newLower.substring(0, Math.min(20, newLower.length))) &&
                                     newLower.length > 10;
          
          if (significantNewInfo) {
            // Smart merge: combine both descriptions
            const merged = `${currentValue}. ${newValue}`;
            const mergedConf = Math.max(currentConf, newConf * 0.9); // Slightly reduce confidence for merged
            return { shouldUpdate: true, newValue: merged, newConf: mergedConf, reason: 'Merged with existing problem description' };
          }
          // If new value is more detailed, replace
          if (newConf > currentConf + 0.1 && newValue.length > currentValue.length) {
            return { shouldUpdate: true, newValue, newConf, reason: 'New problem description is more detailed' };
          }
        }
        // Don't replace if new confidence is significantly lower
        if (newConf < currentConf - 0.2) {
          return { shouldUpdate: false, reason: 'New confidence too low compared to existing' };
        }
        return { shouldUpdate: false, reason: 'Existing problem description preserved' };

      case 'category':
        // Only update if: missing, explicit correction, current is "other", or new confidence is much higher
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        if (isExplicitCorrection || (indicatesCorrection && field === 'category')) {
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly corrected category' };
        }
        // CRITICAL: Preserve high-confidence categories, only update "other" or low-confidence
        if (currentValue === 'other' || currentConf < 0.6) {
          // Allow update if new category is not "other" or has higher confidence
          if (newValue !== 'other' || newConf > currentConf + 0.2) {
            return { shouldUpdate: true, newValue, newConf, reason: 'Updating low-confidence or "other" category' };
          }
        }
        // Don't downgrade: if current category is specific and high-confidence, preserve it
        if (currentValue !== 'other' && currentConf >= 0.7) {
          // Only allow update if new confidence is significantly higher AND not "other"
          if (newConf > currentConf + 0.15 && newValue !== 'other') {
            return { shouldUpdate: true, newValue, newConf, reason: 'New category has significantly higher confidence' };
          }
          return { shouldUpdate: false, reason: 'Preserving high-confidence existing category' };
        }
        // For medium-confidence categories, allow update if new confidence is higher
        if (newConf > currentConf + 0.1 && newValue !== 'other') {
          return { shouldUpdate: true, newValue, newConf, reason: 'New category has higher confidence' };
        }
        return { shouldUpdate: false, reason: 'Existing category preserved' };

      case 'affectedSystem':
        // Merge multiple systems if user mentions more than one, but replace if user explicitly corrects
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        // CRITICAL: Check for explicit corrections like "its not X, it is Y" or "affected system is X"
        const isExplicitSystemCorrection = indicatesCorrection || 
                                          isExplicitCorrection ||
                                          contradictsExisting ||
                                          userExplicitlyUpdatingField ||
                                          /(it'?s\s+not|its\s+not|is\s+not|not\s+my|not\s+the)\s+[^,]+\s*(?:,|but)\s*(?:it'?s|its|it\s+is|is|my|the)\s+/i.test(userMessageLower) ||
                                          /(affected\s+system|system|account)\s+(is|should\s+be|needs?\s+to\s+be)\s+/i.test(userMessageLower);
        
        if (isExplicitSystemCorrection) {
          // User explicitly correcting - replace, don't merge
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly corrected affected system' };
        }
        if (userProvidingInfoAfterWait || userWantsToProvideMore || isExpectedField) {
          // Check if new value mentions additional systems
          const currentLower = currentValue.toLowerCase();
          const newLower = newValue.toLowerCase();
          
          // If new value contradicts existing (contains "not X" pattern), replace
          if (contradictsExisting || (userMessageLower.includes('not') && (userMessageLower.includes(currentLower) || currentLower.includes(userMessageLower.split('not')[1]?.trim())))) {
            return { shouldUpdate: true, newValue, newConf, reason: 'User contradicting existing affected system' };
          }
          
          // If new value contains different system names, merge them
          const hasDifferentSystem = !currentLower.includes(newLower) && 
                                     !newLower.includes(currentLower) &&
                                     newLower.length > 3;
          
          if (hasDifferentSystem) {
            // Merge systems: combine unique system names
            const merged = `${currentValue}, ${newValue}`;
            const mergedConf = Math.max(currentConf, newConf);
            return { shouldUpdate: true, newValue: merged, newConf: mergedConf, reason: 'Merged multiple affected systems' };
          }
          // Replace if new value is more specific/detailed
          if (newConf > currentConf + 0.1 && newValue.length > currentValue.length) {
            return { shouldUpdate: true, newValue, newConf, reason: 'New affected system is more specific' };
          }
        }
        // Don't replace if new confidence is significantly lower (unless explicit correction)
        if (newConf < currentConf - 0.2 && !isExplicitSystemCorrection) {
          return { shouldUpdate: false, reason: 'New confidence too low compared to existing' };
        }
        return { shouldUpdate: false, reason: 'Existing affected system preserved' };

      case 'urgency':
        // Replace if: missing, explicit correction, or user explicitly clarifies
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        // CRITICAL: Check for explicit urgency updates like "make urgency low" or "its not urgent"
        const isExplicitUrgencyUpdate = indicatesCorrection || 
                                       isExpectedField ||
                                       userExplicitlyUpdatingField ||
                                       /(make|set|change|update)\s+(it|its|the|urgency|priority)\s+(to\s+)?(low|high|medium|blocked|urgent|not\s+urgent)/i.test(userMessage) ||
                                       /(urgency|priority)\s+(is|should\s+be|needs?\s+to\s+be|must\s+be)\s+(low|high|medium|blocked|urgent|not\s+urgent)/i.test(userMessage) ||
                                       /(it'?s|its)\s+(not\s+)?(too\s+)?(urgent|high|low|medium)/i.test(userMessage);
        
        if (isExplicitUrgencyUpdate || isExplicitCorrection) {
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly updated urgency' };
        }
        if (userProvidingInfoAfterWait || userWantsToProvideMore) {
          // Replace if new urgency is explicitly stated and has reasonable confidence
          if (newConf >= 0.7) {
            return { shouldUpdate: true, newValue, newConf, reason: 'User provided urgency after wait' };
          }
        }
        // Don't replace if new confidence is significantly lower (unless explicit update)
        if (newConf < currentConf - 0.2 && !isExplicitUrgencyUpdate) {
          return { shouldUpdate: false, reason: 'New confidence too low compared to existing' };
        }
        return { shouldUpdate: false, reason: 'Existing urgency preserved' };

      default:
        // Default behavior for unknown fields: only update if missing or explicit correction
        if (isMissing) {
          return { shouldUpdate: true, newValue, newConf, reason: 'Field missing' };
        }
        if (isExplicitCorrection || indicatesCorrection) {
          return { shouldUpdate: true, newValue, newConf, reason: 'User explicitly corrected field' };
        }
        // Don't replace if new confidence is significantly lower
        if (newConf < currentConf - 0.2) {
          return { shouldUpdate: false, reason: 'New confidence too low compared to existing' };
        }
        return { shouldUpdate: false, reason: 'Existing field preserved' };
    }
  };

  // Apply field-specific update rules
  for (const [field, value] of Object.entries(extractedFields)) {
    // Map 'problem' to 'issue' for database compatibility (but keep 'problem' in memory)
    const dbField = field === 'problem' ? 'issue' : field;
    const currentValue = updatedIntake[field] || updatedIntake[dbField];
    const currentConfidence = updatedConfidence[field] || updatedConfidence[dbField] || 0;
    const newConfidence = extractedConfidence[field] || 0.5;
    
    const updateDecision = updateFieldWithRules(
      field,
      value,
      newConfidence,
      currentValue,
      currentConfidence,
      intent
    );
    
    if (updateDecision.shouldUpdate) {
      // Store as both 'problem' (for code) and 'issue' (for database)
      updatedIntake[field] = updateDecision.newValue;
      if (field === 'problem') {
        updatedIntake.issue = updateDecision.newValue; // Also set 'issue' for database
      }
      updatedConfidence[field] = updateDecision.newConf;
      
      // Comprehensive logging
      if (ENABLE_LOGGING) {
        const logData = {
          field,
          oldValue: currentValue ? (typeof currentValue === 'string' ? currentValue.substring(0, 60) : currentValue) : null,
          newValue: updateDecision.newValue ? (typeof updateDecision.newValue === 'string' ? updateDecision.newValue.substring(0, 60) : updateDecision.newValue) : null,
          oldConfidence: currentConfidence,
          newConfidence: updateDecision.newConf,
          reason: updateDecision.reason,
          userIntent: intent,
          lastExpectedField: sessionState.lastExpectedField,
          isExpectedField: sessionState.lastExpectedField === field,
          indicatesCorrection,
          userProvidingInfoAfterWait,
          userWantsToProvideMore
        };
        console.log('[Conversation Chat] Field update:', logData);
      }
    } else {
      // Field not updated - log why
      if (ENABLE_LOGGING) {
        console.log('[Conversation Chat] Field update skipped:', {
          field,
          currentValue: currentValue ? (typeof currentValue === 'string' ? currentValue.substring(0, 60) : currentValue) : null,
          proposedValue: value ? (typeof value === 'string' ? value.substring(0, 60) : value) : null,
          currentConfidence: currentConfidence,
          proposedConfidence: newConfidence,
          reason: updateDecision.reason,
          userIntent: intent,
          lastExpectedField: sessionState.lastExpectedField,
          isExpectedField: sessionState.lastExpectedField === field
        });
      }
    }
  }

  // Post-processing: Improve category classification based on context
  // CRITICAL: This runs AFTER field updates to prevent downgrades
  // Only improve categories if current category is "other" or missing, or if confidence is low
  const currentCategory = updatedIntake.category;
  const currentCategoryConf = updatedConfidence.category || 0;
  const shouldImproveCategory = !currentCategory || 
                                currentCategory === 'other' || 
                                currentCategoryConf < 0.6;
  
  if (shouldImproveCategory) {
    const problemLower = (updatedIntake.problem || '').toLowerCase();
    const affectedSystemLower = (updatedIntake.affectedSystem || '').toLowerCase();
    const combinedText = `${problemLower} ${affectedSystemLower} ${userMessage.toLowerCase()}`;
    
    let improvedCategory = null;
    let improvedConfidence = 0.8;
    let improvementReason = '';
    
    // Check for email-related keywords (O365, Outlook, email, mail, etc.)
    if (combinedText.includes('o365') || combinedText.includes('outlook') || 
        combinedText.includes('email') || combinedText.includes('mail') || 
        combinedText.includes('exchange') || 
        (combinedText.includes('archway') && (combinedText.includes('email') || combinedText.includes('mail')))) {
      improvedCategory = 'email';
      improvementReason = 'Detected email-related keywords in problem/affectedSystem/user message';
    }
    // Check for password-related keywords
    else if (problemLower.includes('password') || problemLower.includes('login') || 
             problemLower.includes('reset') || problemLower.includes('account password') || 
             problemLower.includes('cannot log in') || problemLower.includes('unable to log') ||
             problemLower.includes('log in') || problemLower.includes('sign in')) {
      improvedCategory = 'password';
      improvementReason = 'Detected password/login-related keywords in problem description';
    }
    
    // Apply improvement if we found a better category
    if (improvedCategory && improvedCategory !== currentCategory) {
      const oldCategory = currentCategory || 'none';
      updatedIntake.category = improvedCategory;
      updatedConfidence.category = Math.max(currentCategoryConf, improvedConfidence);
      
      if (ENABLE_LOGGING) {
        console.log('[Conversation Chat] Improved category classification:', {
          oldCategory,
          newCategory: improvedCategory,
          oldConfidence: currentCategoryConf,
          newConfidence: updatedConfidence.category,
          reason: improvementReason,
          affectedSystem: updatedIntake.affectedSystem,
          problem: updatedIntake.problem?.substring(0, 50)
        });
      }
    }
  } else {
    // Category is already good - log preservation
    if (ENABLE_LOGGING && currentCategory && currentCategory !== 'other') {
      console.log('[Conversation Chat] Category preserved (high confidence):', {
        category: currentCategory,
        confidence: currentCategoryConf,
        reason: 'Category has sufficient confidence and is not "other"'
      });
    }
  }
  
  // Also check user message for category hints (if category still not set after all processing)
  if (!updatedIntake.category) {
    const userMessageLower = userMessage.toLowerCase();
    if (userMessageLower.includes('password') || userMessageLower.includes('reset') || userMessageLower.includes('account password')) {
      updatedIntake.category = 'password';
      updatedConfidence.category = 0.8;
    } else if (userMessageLower.includes('email') || userMessageLower.includes('mail') || userMessageLower.includes('o365') || userMessageLower.includes('outlook')) {
      updatedIntake.category = 'email';
      updatedConfidence.category = 0.8;
    }
  }

  // After extraction, check if we have enough info to submit
  const category = updatedIntake.category;
  const fieldCheckAfterExtraction = checkFieldConfidence(updatedIntake, updatedConfidence, category);
  
  // FIX 4: Enforce deterministic PROBING exit
  // If checkFieldConfidence().valid === true, ALWAYS override brain decision and transition to READY_TO_SUBMIT
  // This ensures no subsequent message can bypass this unless data is explicitly edited
  if (fieldCheckAfterExtraction.valid && 
      brainDecision.action !== 'REDIRECT_OFF_TOPIC' &&
      brainDecision.action !== 'WAIT' &&
      intent !== INTENT.OFF_TOPIC &&
      intent !== INTENT.ASK_QUESTION) {
    // We have all required fields - FORCE transition to READY_TO_SUBMIT
    // This is deterministic and cannot be bypassed
    brainDecision.action = 'SHOW_SUMMARY';
    brainDecision.nextState = 'READY_TO_SUBMIT';
    brainDecision.shouldAskQuestion = false;
    brainDecision.shouldAcknowledge = true;
    brainDecision.acknowledgment = brainDecision.acknowledgment || "Thank you. I have all the information I need.";
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Deterministic PROBING exit - moving to READY_TO_SUBMIT', {
        sessionId,
        category,
        fields: Object.keys(updatedIntake).filter(k => updatedIntake[k]),
        confidence: updatedConfidence,
        previousState: sessionState.conversationState,
        reason: 'All required fields valid with sufficient confidence'
      });
    }
  }

  // ============================================
  // STEP 6: STATE MACHINE ENFORCEMENT
  // ============================================
  let nextState = sessionState.conversationState;

  // FIX 3: Prevent READY_TO_SUBMIT downgrade unless user explicitly edits
  // If we're in READY_TO_SUBMIT and all fields are still valid, stay in READY_TO_SUBMIT
  // Only allow transition away if user indicates correction, explicitly denies submission, or wants to provide more info
  // IMPORTANT: Check CONFIRM_SUBMIT BEFORE protection to allow submission
  const isCurrentlyReady = sessionState.conversationState === CONVERSATION_STATE.READY_TO_SUBMIT;
  const fieldsStillValid = fieldCheckAfterExtraction.valid;
  const userDeniedSubmission = intent === INTENT.DENY_SUBMIT;
  // Reuse indicatesCorrection and userWantsToProvideMore from extraction section (declared above)
  
  // CRITICAL FIX: Check CONFIRM_SUBMIT FIRST before applying protection
  // This allows submission to proceed even when in READY_TO_SUBMIT state
  if (intent === INTENT.CONFIRM_SUBMIT) {
    // Check if we have enough info first
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    
    if (fieldCheck.valid) {
      // We have enough info - submit immediately regardless of current state
      nextState = CONVERSATION_STATE.CONFIRMING_SUBMISSION;
      
      if (ENABLE_LOGGING) {
        console.log('[Conversation Chat] User confirmed submission - transitioning to CONFIRMING_SUBMISSION:', {
          sessionId,
          currentState: sessionState.conversationState,
          nextState: CONVERSATION_STATE.CONFIRMING_SUBMISSION,
          fieldsValid: true
        });
      }
    } else {
      // Not ready - check if we can extract from previous messages
      // If user just provided info and immediately wants to submit, try to extract first
      const missingFields = getMissingFields({ intake: updatedIntake });
      
      if (ENABLE_LOGGING) {
        console.log('[Conversation Chat] User wants to submit but fields not ready:', {
          sessionId,
          missingFields,
          currentIntake: updatedIntake,
          fieldCheck
        });
      }
      
      // If we're missing critical fields, stay in probing but acknowledge the request
      // The response generation will handle showing what's missing
      nextState = sessionState.conversationState;
      
      // Override brain decision to acknowledge submission request
      brainDecision.action = 'ACKNOWLEDGE_ONLY';
      brainDecision.shouldAcknowledge = true;
      brainDecision.acknowledgment = "I understand you'd like me to submit the ticket. Let me check what information I have...";
      brainDecision.shouldAskQuestion = true; // Will ask for missing fields
    }
  } else if (isCurrentlyReady && fieldsStillValid && !userDeniedSubmission && !indicatesCorrection && !userWantsToProvideMore && !userExplicitlyUpdatingField && !userComplainingAboutUpdate) {
    // Protected: Stay in READY_TO_SUBMIT, don't downgrade
    // BUT only if user is NOT confirming submission, correcting, explicitly updating, or complaining (checked above)
    nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] READY_TO_SUBMIT protected - preventing downgrade:', {
        sessionId,
        reason: 'All fields valid, user did not deny submission, indicate correction, explicitly update field, complain, or want to provide more info',
        intent: intent,
        indicatesCorrection,
        userExplicitlyUpdatingField,
        userComplainingAboutUpdate
      });
    }
  } else if (intent === INTENT.OFF_TOPIC) {
    // Stay in current state, but redirect
    nextState = sessionState.conversationState;
  } else if (intent === INTENT.INTERRUPT_WAIT) {
    nextState = CONVERSATION_STATE.WAITING;
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
  
  // STEP 1: Declare nextExpectedField in broader scope so it's accessible after response generation
  // This ensures lastExpectedField is set at question-generation time, not after extraction
  let nextExpectedField = null;

  // Handle special states
  if (nextState === CONVERSATION_STATE.WAITING) {
    responseMessage = brainDecision.acknowledgment || "No problem, take your time. Just let me know when you're ready to continue.";
  } else if (intent === INTENT.CONFIRM_SUBMIT && nextState !== CONVERSATION_STATE.CONFIRMING_SUBMISSION) {
    // User wants to submit but fields aren't ready - show what we have and what's missing
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    const missingFields = getMissingFields({ intake: updatedIntake });
    
    // Build a helpful response showing what we have and what's missing
    const parts = [];
    parts.push("I understand you'd like me to submit the ticket. Let me check what information I have...");
    
    // Check both 'problem' and 'issue' for backward compatibility
    const problemValue = updatedIntake.problem || updatedIntake.issue;
    
    // Show what we have
    const haveParts = [];
    if (problemValue) haveParts.push(`✓ Problem: ${problemValue.substring(0, 100)}${problemValue.length > 100 ? '...' : ''}`);
    if (updatedIntake.category) haveParts.push(`✓ Category: ${updatedIntake.category}`);
    if (updatedIntake.urgency) haveParts.push(`✓ Urgency: ${updatedIntake.urgency}`);
    if (updatedIntake.affectedSystem) haveParts.push(`✓ Affected System: ${updatedIntake.affectedSystem}`);
    if (updatedIntake.errorText && updatedIntake.errorText !== 'no error provided') haveParts.push(`✓ Error Message: ${updatedIntake.errorText.substring(0, 100)}${updatedIntake.errorText.length > 100 ? '...' : ''}`);
    
    if (haveParts.length > 0) {
      parts.push(`\nHere's what I have so far:\n${haveParts.join('\n')}`);
    }
    
    // Show what's missing - normalize field names for display
    if (missingFields.length > 0 || !fieldCheck.valid) {
      const missingList = [];
      if (fieldCheck.missingField) {
        // Map 'problem' to 'issue' for display consistency
        const displayField = fieldCheck.missingField === 'problem' ? 'issue' : fieldCheck.missingField;
        missingList.push(displayField);
      } else if (fieldCheck.lowConfidenceField) {
        const displayField = fieldCheck.lowConfidenceField === 'problem' ? 'issue' : fieldCheck.lowConfidenceField;
        missingList.push(`${displayField} (needs clarification)`);
      }
      // Also add any missing fields from getMissingFields (these are already 'issue')
      missingFields.forEach(field => {
        const displayField = field === 'issue' ? 'issue' : (field === 'problem' ? 'issue' : field);
        if (!missingList.includes(displayField) && !missingList.some(m => m.startsWith(displayField))) {
          missingList.push(displayField);
        }
      });
      
      if (missingList.length > 0) {
        parts.push(`\nI still need: ${missingList.join(', ')}`);
        parts.push(`Could you provide this information so I can submit your ticket?`);
      }
    } else {
      // Shouldn't happen, but just in case
      parts.push(`\nI have all the information I need. Let me prepare the ticket summary...`);
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    }
    
    responseMessage = parts.join('\n');
    brainDecision.shouldAskQuestion = missingFields.length > 0 || !fieldCheck.valid;
  } else if (userComplainingAboutUpdate && Object.keys(extractedFields).length > 0) {
    // User complained about updates not being applied - acknowledge professionally and show updated summary
    const updatedFields = Object.keys(extractedFields);
    const acknowledgment = `I apologize for the confusion. I've now updated the information you provided. `;
    const summary = buildSubmissionSummary(updatedIntake);
    responseMessage = acknowledgment + summary;
    // Ensure we're in READY_TO_SUBMIT state to show the updated summary
    if (nextState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    }
    brainDecision.shouldAskQuestion = false;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] User complaint handled - showing updated summary:', {
        sessionId,
        updatedFields,
        userMessage: userMessage.substring(0, 100)
      });
    }
  } else if (userComplainingAboutUpdate && Object.keys(extractedFields).length === 0) {
    // User complained but no new fields extracted - acknowledge and ask what needs updating
    responseMessage = `I apologize for the confusion. I want to make sure I have the correct information. Could you please tell me specifically what needs to be updated? For example, is it the error message, the affected system, or something else?`;
    nextState = CONVERSATION_STATE.PROBING;
    brainDecision.shouldAskQuestion = false;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] User complaint - no fields extracted, asking for clarification:', {
        sessionId,
        userMessage: userMessage.substring(0, 100)
      });
    }
  } else if (nextState === CONVERSATION_STATE.READY_TO_SUBMIT || brainDecision.action === 'SHOW_SUMMARY') {
    // FIX 3: READY_TO_SUBMIT protection - show summary and don't ask questions
    const summary = buildSubmissionSummary(updatedIntake);
    responseMessage = summary;
    // Ensure we're in READY_TO_SUBMIT state
    if (nextState !== CONVERSATION_STATE.READY_TO_SUBMIT) {
      nextState = CONVERSATION_STATE.READY_TO_SUBMIT;
    }
    // Override brain decision to prevent asking questions
    brainDecision.shouldAskQuestion = false;
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
    // FIX 3: Also don't ask if we're in READY_TO_SUBMIT and fields are still valid
    const category = updatedIntake.category;
    const fieldCheck = checkFieldConfidence(updatedIntake, updatedConfidence, category);
    const isReadyStateProtected = nextState === CONVERSATION_STATE.READY_TO_SUBMIT && fieldCheck.valid;
    const shouldNotAsk = fieldCheck.valid || (intent === INTENT.FRUSTRATION && fieldCheck.valid) || isReadyStateProtected;

    // STEP 1: Determine which field we're asking about BEFORE generating the question
    
    if (brainDecision.shouldAskQuestion && !shouldNotAsk) {
      if (brainDecision.questionToAsk) {
        // Brain provided a question - try to infer field from question text or use brain's fieldsToExtract
        if (brainDecision.fieldsToExtract && brainDecision.fieldsToExtract.length > 0) {
          nextExpectedField = brainDecision.fieldsToExtract[0];
        } else {
          // Infer from question text (fallback)
          const questionLower = brainDecision.questionToAsk.toLowerCase();
          if (questionLower.includes('urgent') || questionLower.includes('urgency') || questionLower.includes('priority')) {
            nextExpectedField = 'urgency';
          } else if (questionLower.includes('error') || questionLower.includes('message')) {
            nextExpectedField = 'errorText';
          } else if (questionLower.includes('system') || questionLower.includes('application') || questionLower.includes('which')) {
            nextExpectedField = 'affectedSystem';
          } else if (questionLower.includes('category') || questionLower.includes('type')) {
            nextExpectedField = 'category';
          } else if (questionLower.includes('issue') || questionLower.includes('problem') || questionLower.includes('describe')) {
            nextExpectedField = 'problem';
          }
        }
        parts.push(brainDecision.questionToAsk);
      } else {
        // Generate probing question - determine field BEFORE generating
        // STEP 5: Align probing with confidence model
        // Check both value existence AND confidence scores
        const missingFieldsByValue = getMissingFields({ intake: updatedIntake });
        const missingFieldsByConfidence = [];
        
        // Also check for fields with low confidence (below threshold)
        // Use the fieldCheck we already computed above
        if (!fieldCheck.valid && fieldCheck.lowConfidenceField) {
          // Field exists but has low confidence - treat as missing for probing purposes
          missingFieldsByConfidence.push(fieldCheck.lowConfidenceField);
        }
        
        // Combine both lists (avoid duplicates)
        const allMissingFields = [...new Set([...missingFieldsByValue, ...missingFieldsByConfidence])];
        
        if (allMissingFields.length > 0) {
          // STEP 1: Determine which field we're asking about
          nextExpectedField = getNextField(allMissingFields, category);
          
          const question = await generateProbingQuestion(
            sessionState,
            allMissingFields,
            userMessage,
            brainDecision.acknowledgment
          );
          if (question) {
            parts.push(question);
          }
          
          if (ENABLE_LOGGING && missingFieldsByConfidence.length > 0) {
            console.log('[Conversation Chat] Including low-confidence fields in probing:', {
              lowConfidenceFields: missingFieldsByConfidence,
              reason: 'Fields exist but confidence below threshold - asking for confirmation'
            });
          }
        }
      }
    }

    responseMessage = parts.join(' ') || brainDecision.acknowledgment || "I understand. Could you tell me more about the issue?";
  }

  // ============================================
  // STEP 9: UPDATE SESSION STATE
  // ============================================
  
  // STEP 2: Preserve lastExpectedField when ACKNOWLEDGE_ONLY is returned
  // Only update lastExpectedField if:
  // 1. We're asking a new probing question (nextExpectedField is set)
  // 2. Brain explicitly specified fieldsToExtract (new extraction intent)
  // 3. We're transitioning away from PROBING state (clear context)
  // Otherwise, preserve the existing lastExpectedField to maintain context
  let finalLastExpectedField = sessionState.lastExpectedField; // Preserve by default
  
  if (nextExpectedField) {
    // STEP 1: We're asking a new question - set the expected field immediately
    finalLastExpectedField = nextExpectedField;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Setting lastExpectedField at question-generation time:', {
        field: nextExpectedField,
        reason: 'New probing question generated',
        questionPreview: responseMessage.substring(0, 100)
      });
    }
  } else if (brainDecision.fieldsToExtract && brainDecision.fieldsToExtract.length > 0) {
    // Brain explicitly specified extraction - use that
    finalLastExpectedField = brainDecision.fieldsToExtract[0];
  } else if (nextState !== CONVERSATION_STATE.PROBING && sessionState.conversationState === CONVERSATION_STATE.PROBING) {
    // Transitioning away from PROBING - clear context
    finalLastExpectedField = null;
    
    if (ENABLE_LOGGING) {
      console.log('[Conversation Chat] Clearing lastExpectedField:', {
        reason: 'Transitioning away from PROBING state',
        fromState: sessionState.conversationState,
        toState: nextState
      });
    }
  } else if (brainDecision.action === 'ACKNOWLEDGE_ONLY' && nextState === CONVERSATION_STATE.PROBING) {
    // STEP 2: ACKNOWLEDGE_ONLY in PROBING - preserve lastExpectedField
    // Don't clear it, keep the context for forced extraction
    // finalLastExpectedField remains unchanged (preserved above)
    
    if (ENABLE_LOGGING && sessionState.lastExpectedField) {
      console.log('[Conversation Chat] Preserving lastExpectedField during ACKNOWLEDGE_ONLY:', {
        preservedField: sessionState.lastExpectedField,
        reason: 'ACKNOWLEDGE_ONLY in PROBING state - maintaining context for forced extraction'
      });
    }
  }
  
  // Ensure 'issue' field is set for database compatibility (maps from 'problem')
  if (updatedIntake.problem && !updatedIntake.issue) {
    updatedIntake.issue = updatedIntake.problem;
  }
  
  await updateSessionState(sessionId, {
    intake: updatedIntake,
    confidenceByField: updatedConfidence,
    conversationState: nextState,
    lastBotQuestion: responseMessage,
    lastExpectedField: finalLastExpectedField,
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

