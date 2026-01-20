import { createIntakeResponse, getIntakeResponsesAsObject } from '../models/intakeResponseModel.js';
import { updateSession } from '../models/sessionModel.js';
import { detectSensitiveData } from './sensitiveDataDetection.js';

export const PROBING_STEPS = {
  INITIAL_PROBLEM: 'initial_problem',
  FOLLOW_UP_DETAILS: 'follow_up_details',
  URGENCY_IMPACT: 'urgency_impact',
  AFFECTED_SYSTEM: 'affected_system',
  ERROR_MESSAGE: 'error_message',
  ADDITIONAL_CONTEXT: 'additional_context',
  COMPLETE: 'complete'
};

export const INTAKE_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete'
};

const CATEGORIES = {
  PASSWORD: 'password',
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
  NETWORK: 'network',
  EMAIL: 'email',
  OTHER: 'other'
};

const URGENCY_LEVELS = ['low', 'medium', 'high', 'critical'];

const generateFollowUpQuestions = (responses) => {
  const problemDesc = (responses[PROBING_STEPS.INITIAL_PROBLEM] || '').toLowerCase();
  const questions = [];

  if (!problemDesc || problemDesc.length < 10) {
    questions.push("Can you provide more details about the issue?");
  } else {
    if (problemDesc.includes('error') || problemDesc.includes('crash') || problemDesc.includes('fail')) {
      questions.push("When did this error first occur?");
      questions.push("What were you doing when it happened?");
    } else if (problemDesc.includes('slow') || problemDesc.includes('lag') || problemDesc.includes('freeze')) {
      questions.push("How long has this been happening?");
      questions.push("Is this affecting just you or multiple users?");
    } else if (problemDesc.includes('access') || problemDesc.includes('login') || problemDesc.includes('password')) {
      questions.push("Are you able to access any other systems?");
      questions.push("When did you last successfully log in?");
    } else if (problemDesc.includes('email') || problemDesc.includes('mail')) {
      questions.push("Are you unable to send, receive, or both?");
      questions.push("What email client are you using?");
    } else if (problemDesc.includes('network') || problemDesc.includes('internet') || problemDesc.includes('connection')) {
      questions.push("Are other devices on the same network working?");
      questions.push("Can you access any websites at all?");
    } else {
      questions.push("Can you tell me more about what you were trying to do?");
      questions.push("What happens when you try to use the system?");
    }
  }

  return questions.slice(0, 2);
};

const determineCategory = (responses) => {
  const problemDesc = (responses[PROBING_STEPS.INITIAL_PROBLEM] || '').toLowerCase();
  const followUp = (responses[PROBING_STEPS.FOLLOW_UP_DETAILS] || '').toLowerCase();
  const affectedSystem = (responses[PROBING_STEPS.AFFECTED_SYSTEM] || '').toLowerCase();
  const errorMessage = (responses[PROBING_STEPS.ERROR_MESSAGE] || '').toLowerCase();

  const combinedText = `${problemDesc} ${followUp} ${affectedSystem} ${errorMessage}`;

  if (combinedText.includes('password') || combinedText.includes('login') || combinedText.includes('credential') || combinedText.includes('authentication')) {
    return CATEGORIES.PASSWORD;
  }

  if (combinedText.includes('hardware') || combinedText.includes('device') || combinedText.includes('computer') || combinedText.includes('printer') || combinedText.includes('monitor') || combinedText.includes('keyboard') || combinedText.includes('mouse')) {
    return CATEGORIES.HARDWARE;
  }

  if (combinedText.includes('software') || combinedText.includes('application') || combinedText.includes('app') || combinedText.includes('program') || combinedText.includes('browser')) {
    return CATEGORIES.SOFTWARE;
  }

  if (combinedText.includes('network') || combinedText.includes('internet') || combinedText.includes('connection') || combinedText.includes('wifi') || combinedText.includes('ethernet') || combinedText.includes('vpn')) {
    return CATEGORIES.NETWORK;
  }

  if (combinedText.includes('email') || combinedText.includes('mail') || combinedText.includes('outlook') || combinedText.includes('gmail') || combinedText.includes('exchange')) {
    return CATEGORIES.EMAIL;
  }

  return CATEGORIES.OTHER;
};

const determineUrgency = (responses) => {
  const urgencyResponse = responses[PROBING_STEPS.URGENCY_IMPACT] || '';
  const normalized = urgencyResponse.toLowerCase().trim();

  if (URGENCY_LEVELS.includes(normalized)) {
    return normalized;
  }

  const urgencyText = normalized;
  if (urgencyText.includes('critical') || urgencyText.includes('urgent') || urgencyText.includes('emergency') || urgencyText.includes('down') || urgencyText.includes('blocked')) {
    return 'critical';
  }
  if (urgencyText.includes('high') || urgencyText.includes('important') || urgencyText.includes('affecting')) {
    return 'high';
  }
  if (urgencyText.includes('low') || urgencyText.includes('minor') || urgencyText.includes('not urgent')) {
    return 'low';
  }

  return 'medium';
};

const hasEnoughInfo = (responses) => {
  const hasInitialProblem = responses[PROBING_STEPS.INITIAL_PROBLEM] && responses[PROBING_STEPS.INITIAL_PROBLEM].trim().length >= 10;
  const hasFollowUp = responses[PROBING_STEPS.FOLLOW_UP_DETAILS] && responses[PROBING_STEPS.FOLLOW_UP_DETAILS].trim().length >= 5;
  const hasUrgency = responses[PROBING_STEPS.URGENCY_IMPACT] && responses[PROBING_STEPS.URGENCY_IMPACT].trim().length > 0;
  const hasAffectedSystem = responses[PROBING_STEPS.AFFECTED_SYSTEM] && responses[PROBING_STEPS.AFFECTED_SYSTEM].trim().length > 0;
  const hasErrorMessage = responses[PROBING_STEPS.ERROR_MESSAGE] !== undefined;

  return hasInitialProblem && hasFollowUp && hasUrgency && hasAffectedSystem && hasErrorMessage;
};

export const processProbingResponse = async (sessionId, currentStep, userMessage, session) => {
  const sensitiveCheck = detectSensitiveData(userMessage);
  
  if (sensitiveCheck.detected) {
    await createIntakeResponse(sessionId, 'sensitive_data_warning', userMessage);
    return {
      warning: true,
      message: sensitiveCheck.message,
      nextStep: currentStep,
      intakeStatus: session.intake_status
    };
  }

  const sanitizedMessage = userMessage.trim();

  if (currentStep === PROBING_STEPS.INITIAL_PROBLEM || !currentStep) {
    await createIntakeResponse(sessionId, PROBING_STEPS.INITIAL_PROBLEM, sanitizedMessage);
    
    const responses = await getIntakeResponsesAsObject(sessionId);
    const followUpQuestions = generateFollowUpQuestions(responses);
    
    if (followUpQuestions.length > 0) {
      await updateSession(sessionId, {
        current_step: PROBING_STEPS.FOLLOW_UP_DETAILS
      });
      
      return {
        nextStep: PROBING_STEPS.FOLLOW_UP_DETAILS,
        question: followUpQuestions[0],
        intakeStatus: INTAKE_STATUS.IN_PROGRESS
      };
    } else {
      await updateSession(sessionId, {
        current_step: PROBING_STEPS.URGENCY_IMPACT
      });
      
      return {
        nextStep: PROBING_STEPS.URGENCY_IMPACT,
        question: "How urgent is this issue? Is it blocking you from working, or is it a minor inconvenience?",
        intakeStatus: INTAKE_STATUS.IN_PROGRESS
      };
    }
  }

  if (currentStep === PROBING_STEPS.FOLLOW_UP_DETAILS) {
    await createIntakeResponse(sessionId, PROBING_STEPS.FOLLOW_UP_DETAILS, sanitizedMessage);
    
    await updateSession(sessionId, {
      current_step: PROBING_STEPS.URGENCY_IMPACT
    });
    
    return {
      nextStep: PROBING_STEPS.URGENCY_IMPACT,
      question: "How urgent is this issue? Is it blocking you from working, or is it a minor inconvenience?",
      intakeStatus: INTAKE_STATUS.IN_PROGRESS
    };
  }

  if (currentStep === PROBING_STEPS.URGENCY_IMPACT) {
    await createIntakeResponse(sessionId, PROBING_STEPS.URGENCY_IMPACT, sanitizedMessage);
    
    await updateSession(sessionId, {
      current_step: PROBING_STEPS.AFFECTED_SYSTEM
    });
    
    return {
      nextStep: PROBING_STEPS.AFFECTED_SYSTEM,
      question: "What system, application, or device is affected?",
      intakeStatus: INTAKE_STATUS.IN_PROGRESS
    };
  }

  if (currentStep === PROBING_STEPS.AFFECTED_SYSTEM) {
    await createIntakeResponse(sessionId, PROBING_STEPS.AFFECTED_SYSTEM, sanitizedMessage);
    
    await updateSession(sessionId, {
      current_step: PROBING_STEPS.ERROR_MESSAGE
    });
    
    return {
      nextStep: PROBING_STEPS.ERROR_MESSAGE,
      question: 'If you received an error message, please share it. Otherwise, type "none".',
      intakeStatus: INTAKE_STATUS.IN_PROGRESS
    };
  }

  if (currentStep === PROBING_STEPS.ERROR_MESSAGE) {
    await createIntakeResponse(sessionId, PROBING_STEPS.ERROR_MESSAGE, sanitizedMessage);
    
    const responses = await getIntakeResponsesAsObject(sessionId);
    
    if (hasEnoughInfo(responses)) {
      const category = determineCategory(responses);
      await updateSession(sessionId, {
        intake_status: INTAKE_STATUS.COMPLETE,
        current_step: PROBING_STEPS.COMPLETE,
        category: category
      });
      
      return {
        nextStep: PROBING_STEPS.COMPLETE,
        question: null,
        intakeStatus: INTAKE_STATUS.COMPLETE,
        category: category
      };
    } else {
      await updateSession(sessionId, {
        current_step: PROBING_STEPS.ADDITIONAL_CONTEXT
      });
      
      return {
        nextStep: PROBING_STEPS.ADDITIONAL_CONTEXT,
        question: "Is there anything else we should know about this issue?",
        intakeStatus: INTAKE_STATUS.IN_PROGRESS
      };
    }
  }

  if (currentStep === PROBING_STEPS.ADDITIONAL_CONTEXT) {
    await createIntakeResponse(sessionId, PROBING_STEPS.ADDITIONAL_CONTEXT, sanitizedMessage);
    
    const responses = await getIntakeResponsesAsObject(sessionId);
    const category = determineCategory(responses);
    
    await updateSession(sessionId, {
      intake_status: INTAKE_STATUS.COMPLETE,
      current_step: PROBING_STEPS.COMPLETE,
      category: category
    });
    
    return {
      nextStep: PROBING_STEPS.COMPLETE,
      question: null,
      intakeStatus: INTAKE_STATUS.COMPLETE,
      category: category
    };
  }

  return {
    nextStep: currentStep,
    question: null,
    intakeStatus: session.intake_status
  };
};

export const getInitialQuestion = () => {
  return "What's going on?";
};

export { determineCategory, determineUrgency };

export const isIntakeComplete = (session) => {
  return session.intake_status === INTAKE_STATUS.COMPLETE;
};

