import { getUserById } from '../models/userModel.js';
import { getSessionBySessionId } from '../models/sessionModel.js';
import { getIntakeResponsesAsObject } from '../models/intakeResponseModel.js';
import { getMessagesBySessionId } from '../models/messageModel.js';
import { PROBING_STEPS, determineUrgency } from './probingIntakeEngine.js';
import { v4 as uuidv4 } from 'uuid';

export const generateTicketPayload = async (sessionId) => {
  const session = await getSessionBySessionId(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  const responses = await getIntakeResponsesAsObject(sessionId);
  const messages = await getMessagesBySessionId(sessionId);
  
  let user = null;
  if (session.user_id) {
    user = await getUserById(session.user_id);
  }

  const problemDescription = responses[PROBING_STEPS.INITIAL_PROBLEM] || '';
  const followUpDetails = responses[PROBING_STEPS.FOLLOW_UP_DETAILS] || '';
  const urgencyResponse = responses[PROBING_STEPS.URGENCY_IMPACT] || '';
  const affectedSystem = responses[PROBING_STEPS.AFFECTED_SYSTEM] || '';
  const errorMessage = responses[PROBING_STEPS.ERROR_MESSAGE] || '';
  const additionalContext = responses[PROBING_STEPS.ADDITIONAL_CONTEXT] || '';

  const urgency = determineUrgency(responses);
  
  const summary = problemDescription 
    ? `${problemDescription.substring(0, 150)}${problemDescription.length > 150 ? '...' : ''}`
    : 'No description provided';

  const ticket = {
    ticketId: `TICKET-${uuidv4().substring(0, 8).toUpperCase()}`,
    sessionId: session.session_id,
    createdAt: new Date().toISOString(),
    
    customer: {
      fullName: session.user_name || user?.full_name || 'Not provided',
      email: session.email || user?.email || 'Not provided',
      phone: session.phone || user?.phone || 'Not provided',
      company: session.company || user?.company || 'Not provided',
      vsaAgentName: session.vsa_agent_name || user?.vsa_agent_name || 'Not provided'
    },
    
    user: user ? {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      role: user.role
    } : null,
    
    category: session.category || 'other',
    urgency: urgency,
    impact: urgencyResponse.includes('blocked') || urgencyResponse.includes('multiple') 
      ? 'blocked' 
      : urgencyResponse.includes('single') || urgencyResponse.includes('just me')
      ? 'single_user'
      : 'unknown',
    
    summary: summary,
    
    details: {
      problemDescription: problemDescription || 'Not provided',
      followUpDetails: followUpDetails || 'Not provided',
      urgency: urgencyResponse || 'Not specified',
      affectedSystem: affectedSystem || 'Not specified',
      errorMessage: errorMessage === 'none' || errorMessage.toLowerCase().includes('none')
        ? 'No error message provided'
        : (errorMessage || 'Not provided'),
      additionalContext: additionalContext || null
    },
    
    keyDetails: [
      problemDescription ? `Problem: ${problemDescription}` : null,
      urgencyResponse ? `Urgency: ${urgencyResponse}` : null,
      affectedSystem ? `Affected System: ${affectedSystem}` : null,
      errorMessage && errorMessage !== 'none' && !errorMessage.toLowerCase().includes('none') 
        ? `Error: ${errorMessage}` 
        : null,
      additionalContext ? `Additional Context: ${additionalContext}` : null
    ].filter(Boolean),
    
    chatTranscript: messages.map(msg => ({
      sender: msg.sender,
      message: msg.message_text,
      timestamp: msg.created_at
    })),
    
    metadata: {
      sessionStatus: session.status,
      intakeStatus: session.intake_status,
      sessionCreatedAt: session.created_at,
      sessionUpdatedAt: session.updated_at
    }
  };

  return ticket;
};

