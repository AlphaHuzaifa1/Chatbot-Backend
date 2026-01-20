import { sendTicketEmail } from './emailService.js';
import { createTicket, updateTicket } from '../models/ticketModel.js';
import { getSessionBySessionId } from '../models/sessionModel.js';
import { v4 as uuidv4 } from 'uuid';
import { generateTicketPayload } from './ticketService.js';

/**
 * Ticket Submission Service
 * Handles the complete ticket submission flow:
 * - Validates session ownership
 * - Generates unique reference ID
 * - Sends support email
 * - Persists minimal metadata
 * - Handles errors gracefully
 */

/**
 * Generate a human-readable reference ID
 * Format: REF-YYYYMMDD-XXXXXX
 */
const generateReferenceId = () => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const randomStr = uuidv4().substring(0, 6).toUpperCase();
  return `REF-${dateStr}-${randomStr}`;
};

/**
 * Validate that the session belongs to the requesting user (if authenticated)
 * For guest sessions, just check that session exists
 */
const validateSessionOwnership = async (sessionId, userId = null) => {
  const session = await getSessionBySessionId(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }

  // If user is authenticated, verify session belongs to them
  if (userId && session.user_id) {
    if (session.user_id !== userId) {
      throw new Error('Session does not belong to user');
    }
  }

  return session;
};

/**
 * Submit a ticket from a ticket payload
 * This is the main entry point for ticket submission
 */
export const submitTicket = async (ticketPayload, sessionId, userId = null) => {
  // Validate session ownership
  await validateSessionOwnership(sessionId, userId);

  // Generate unique reference ID
  const referenceId = generateReferenceId();
  
  // Add reference ID to ticket payload
  const ticket = {
    ...ticketPayload,
    referenceId
  };

  let ticketStatus = 'submitted';
  let emailSent = false;
  let emailError = null;

  // Attempt to send email
  try {
    const emailResult = await sendTicketEmail(ticket);
    
    if (emailResult.success) {
      emailSent = true;
      if (emailResult.testMode) {
        // In test mode, we still consider it successful
        ticketStatus = 'submitted';
      }
    } else if (emailResult.skipped) {
      // Email was skipped (disabled), still mark as submitted
      ticketStatus = 'submitted';
      emailSent = false;
    } else {
      // Email failed, but we still want to create the ticket
      emailError = emailResult.error || 'Unknown error';
      ticketStatus = 'submitted'; // Still mark as submitted, not failed
      
      // Log the error safely (without sensitive data)
      console.error('Email sending failed for ticket submission:', {
        referenceId,
        sessionId,
        error: emailError
      });
    }
  } catch (error) {
    // Unexpected error during email sending
    emailError = error.message;
    ticketStatus = 'submitted'; // Still mark as submitted
    console.error('Unexpected error during email sending:', {
      referenceId,
      sessionId,
      error: error.message
    });
  }

  // Persist ticket metadata (do NOT store sensitive content)
  let ticketRecord;
  try {
    ticketRecord = await createTicket({
      referenceId,
      sessionId,
      category: ticket.category || 'other',
      status: ticketStatus,
      emailSent,
      emailError: emailError ? emailError.substring(0, 500) : null // Limit error length
    });
  } catch (dbError) {
    // If DB write fails, log but don't block the user
    console.error('Failed to persist ticket metadata:', {
      referenceId,
      sessionId,
      error: dbError.message
    });
    
    // Still return success with reference ID
    return {
      success: true,
      referenceId,
      sessionId,
      emailSent: false,
      emailError: 'Database write failed',
      warning: 'Ticket submitted but metadata could not be saved'
    };
  }

  return {
    success: true,
    referenceId,
    sessionId,
    emailSent,
    emailError: emailError || null,
    ticketRecord,
    testMode: process.env.TEST_MODE === 'true'
  };
};

/**
 * Submit ticket by session ID
 * Convenience function that generates payload and submits
 */
export const submitTicketBySessionId = async (sessionId, userId = null) => {
  // Validate session exists
  await validateSessionOwnership(sessionId, userId);

  // Generate ticket payload from session
  const ticketPayload = await generateTicketPayload(sessionId);

  // Submit the ticket
  return await submitTicket(ticketPayload, sessionId, userId);
};

export default {
  submitTicket,
  submitTicketBySessionId
};
