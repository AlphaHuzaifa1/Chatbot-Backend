export const INTAKE_STEPS = {
  PROBLEM_DESCRIPTION: 'problem_description',
  URGENCY: 'urgency',
  AFFECTED_SYSTEM: 'affected_system',
  ERROR_MESSAGE: 'error_message',
  COMPLETE: 'complete'
};

export const INTAKE_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete'
};

export const CATEGORIES = {
  PASSWORD: 'password',
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
  NETWORK: 'network',
  EMAIL: 'email',
  OTHER: 'other'
};

export const URGENCY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

const STEP_QUESTIONS = {
  [INTAKE_STEPS.PROBLEM_DESCRIPTION]: 'Please describe the problem you\'re experiencing in detail.',
  [INTAKE_STEPS.URGENCY]: 'How urgent is this issue? (low, medium, high, critical)',
  [INTAKE_STEPS.AFFECTED_SYSTEM]: 'What system, app, or device is affected?',
  [INTAKE_STEPS.ERROR_MESSAGE]: 'If you received an error message, please share it. Otherwise, type "none".'
};

export const getNextStep = (currentStep) => {
  const stepOrder = [
    INTAKE_STEPS.PROBLEM_DESCRIPTION,
    INTAKE_STEPS.URGENCY,
    INTAKE_STEPS.AFFECTED_SYSTEM,
    INTAKE_STEPS.ERROR_MESSAGE
  ];

  const currentIndex = stepOrder.indexOf(currentStep);
  if (currentIndex === -1 || currentIndex === stepOrder.length - 1) {
    return INTAKE_STEPS.COMPLETE;
  }

  return stepOrder[currentIndex + 1];
};

export const getQuestionForStep = (step) => {
  return STEP_QUESTIONS[step] || null;
};

export const determineCategory = (responses) => {
  const problemDesc = (responses[INTAKE_STEPS.PROBLEM_DESCRIPTION] || '').toLowerCase();
  const affectedSystem = (responses[INTAKE_STEPS.AFFECTED_SYSTEM] || '').toLowerCase();
  const errorMessage = (responses[INTAKE_STEPS.ERROR_MESSAGE] || '').toLowerCase();

  const combinedText = `${problemDesc} ${affectedSystem} ${errorMessage}`;

  if (combinedText.includes('password') || combinedText.includes('login') || combinedText.includes('credential')) {
    return CATEGORIES.PASSWORD;
  }

  if (combinedText.includes('hardware') || combinedText.includes('device') || combinedText.includes('computer') || combinedText.includes('printer') || combinedText.includes('monitor')) {
    return CATEGORIES.HARDWARE;
  }

  if (combinedText.includes('software') || combinedText.includes('application') || combinedText.includes('app') || combinedText.includes('program')) {
    return CATEGORIES.SOFTWARE;
  }

  if (combinedText.includes('network') || combinedText.includes('internet') || combinedText.includes('connection') || combinedText.includes('wifi') || combinedText.includes('ethernet')) {
    return CATEGORIES.NETWORK;
  }

  if (combinedText.includes('email') || combinedText.includes('mail') || combinedText.includes('outlook') || combinedText.includes('gmail')) {
    return CATEGORIES.EMAIL;
  }

  return CATEGORIES.OTHER;
};

export const isIntakeComplete = (responses) => {
  return (
    responses[INTAKE_STEPS.PROBLEM_DESCRIPTION] &&
    responses[INTAKE_STEPS.URGENCY] &&
    responses[INTAKE_STEPS.AFFECTED_SYSTEM] &&
    responses[INTAKE_STEPS.ERROR_MESSAGE]
  );
};

export const validateUrgency = (urgency) => {
  const normalized = urgency.toLowerCase().trim();
  return Object.values(URGENCY_LEVELS).includes(normalized) ? normalized : URGENCY_LEVELS.MEDIUM;
};

