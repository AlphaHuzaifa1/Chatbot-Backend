/**
 * CATEGORY-SPECIFIC MANDATORY PROBES
 * 
 * This module enforces category-specific minimum probing requirements
 * before ticket submission can be offered. This ensures technician-style
 * intake quality without breaking existing validation logic.
 * 
 * Requirements:
 * - HARDWARE: Must collect at least 2 of: deviceType, powerSymptoms, impact, scope
 * - PASSWORD: Must collect passwordContext
 * 
 * These checks are ADDITIVE to existing field requirements, not replacements.
 */

const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

/**
 * Check if category-specific mandatory probes are satisfied
 * 
 * @param {string} category - Issue category
 * @param {Object} intake - Current intake fields
 * @returns {Object} { satisfied: boolean, missingProbes: Array<string>, reason: string }
 */
export const checkCategorySpecificProbes = (category, intake) => {
  if (!category) {
    // Category not determined yet - probes not applicable
    return { satisfied: true, missingProbes: [], reason: 'Category not determined' };
  }

  const categoryLower = category.toLowerCase();

  // HARDWARE category: Must collect at least 2 of: deviceType, powerSymptoms, impact, scope
  if (categoryLower === 'hardware') {
    const hardwareProbes = {
      deviceType: intake.deviceType || null,
      powerSymptoms: intake.powerSymptoms || null,
      impact: intake.impact || null,
      scope: intake.scope || null
    };

    const collectedProbes = Object.values(hardwareProbes).filter(v => v !== null && v !== undefined && v !== '').length;

    if (collectedProbes >= 2) {
      return { satisfied: true, missingProbes: [], reason: 'Hardware probes satisfied' };
    }

    const missingProbes = Object.entries(hardwareProbes)
      .filter(([_, value]) => !value || value === null || value === '')
      .map(([key, _]) => key);

    return {
      satisfied: false,
      missingProbes,
      reason: `Hardware category requires at least 2 of: deviceType, powerSymptoms, impact, scope. Currently have ${collectedProbes}.`,
      requiredCount: 2,
      currentCount: collectedProbes
    };
  }

  // PASSWORD category: Must collect passwordContext
  if (categoryLower === 'password') {
    const passwordContext = intake.passwordContext || null;

    if (passwordContext && passwordContext !== '' && passwordContext !== 'no error provided') {
      return { satisfied: true, missingProbes: [], reason: 'Password context collected' };
    }

    return {
      satisfied: false,
      missingProbes: ['passwordContext'],
      reason: 'Password category requires passwordContext (desktop login | email | specific application)'
    };
  }

  // Other categories: No additional mandatory probes (existing requirements apply)
  return { satisfied: true, missingProbes: [], reason: 'No category-specific probes required' };
};

/**
 * Get next mandatory probe field to ask about
 * 
 * @param {string} category - Issue category
 * @param {Object} intake - Current intake fields
 * @returns {string|null} Field name to ask about next, or null if all satisfied
 */
export const getNextMandatoryProbe = (category, intake) => {
  if (!category) {
    return null;
  }

  const categoryLower = category.toLowerCase();
  const probeCheck = checkCategorySpecificProbes(category, intake);

  if (probeCheck.satisfied) {
    return null;
  }

  // Return first missing probe
  if (probeCheck.missingProbes.length > 0) {
    return probeCheck.missingProbes[0];
  }

  return null;
};

/**
 * Get technician-style question for mandatory probe field
 * 
 * @param {string} field - Field name (passwordContext, deviceType, powerSymptoms, impact, scope)
 * @param {string} category - Issue category
 * @returns {string} Question text
 */
export const getMandatoryProbeQuestion = (field, category) => {
  const questions = {
    passwordContext: [
      "Is this password for your computer login, email, or another application?",
      "What is this password for - your desktop login, email account, or a specific application?",
      "Which password are you having trouble with - computer login, email, or an application?"
    ],
    deviceType: [
      "Is this a laptop or desktop computer?",
      "What type of device is this - laptop or desktop?",
      "Are you using a laptop or desktop?"
    ],
    powerSymptoms: [
      "Do you see any lights or error messages when you try to turn it on?",
      "What happens when you try to power it on - any lights, fan noise, or blank screen?",
      "When you try to turn it on, do you see lights, hear fan noise, or just a blank screen?"
    ],
    impact: [
      "Is this preventing you from working right now?",
      "Is this blocking your work completely, or can you still get some things done?",
      "How is this affecting your ability to work - completely blocked or just slower?"
    ],
    scope: [
      "Is this affecting only you or others as well?",
      "Are you the only one experiencing this, or are other people affected too?",
      "Is this just happening to you, or are multiple people having the same issue?"
    ]
  };

  const fieldQuestions = questions[field];
  if (!fieldQuestions || fieldQuestions.length === 0) {
    return `Could you provide more details about ${field}?`;
  }

  // Return random question for variety
  return fieldQuestions[Math.floor(Math.random() * fieldQuestions.length)];
};

/**
 * Check if initial issue description has been followed up
 * This ensures at least one probing question is asked after initial description
 * 
 * @param {Object} sessionState - Current session state
 * @returns {boolean} True if at least one follow-up question has been asked
 */
export const hasFollowedUpInitialIssue = (sessionState) => {
  // Check if we have asked at least one question after initial issue was provided
  const messages = sessionState.messages || [];
  const askedQuestions = sessionState.askedQuestions || [];
  
  // If we have asked questions, we've followed up
  if (askedQuestions.length > 0) {
    return true;
  }

  // Check message history: if we have user message + bot response after issue was set
  const intake = sessionState.intake || {};
  const hasIssue = intake.problem || intake.issue;
  
  if (!hasIssue) {
    // No issue yet, so follow-up not applicable
    return true;
  }

  // Count bot messages after issue was likely set
  // Simple heuristic: if we have at least 2 bot messages, we've likely followed up
  const botMessages = messages.filter(msg => msg.sender === 'system' || msg.sender === 'bot');
  if (botMessages.length >= 2) {
    return true;
  }

  // More sophisticated: check if lastExpectedField was set (indicates we asked a probing question)
  if (sessionState.lastExpectedField) {
    return true;
  }

  return false;
};

export default {
  checkCategorySpecificProbes,
  getNextMandatoryProbe,
  getMandatoryProbeQuestion,
  hasFollowedUpInitialIssue
};

