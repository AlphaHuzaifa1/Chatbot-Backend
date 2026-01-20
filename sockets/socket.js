import { Server } from 'socket.io';
import { getSessionBySessionId, updateSession } from '../models/sessionModel.js';
import { createMessage } from '../models/messageModel.js';
import { processProbingResponse, PROBING_STEPS, INTAKE_STATUS, getInitialQuestion, isIntakeComplete } from '../services/probingIntakeEngine.js';
import { generateTicketPayload } from '../services/ticketService.js';
import { submitTicket } from '../services/ticketSubmissionService.js';

let io = null;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  io.use(async (socket, next) => {
    const sessionId = socket.handshake.auth.sessionId;
    
    if (!sessionId) {
      return next(new Error('Session ID is required'));
    }

    try {
      const session = await getSessionBySessionId(sessionId);
      if (!session) {
        return next(new Error('Invalid session ID'));
      }
      
      socket.sessionId = sessionId;
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Session validation failed'));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`Client connected: ${socket.id}, Session: ${socket.sessionId}`);

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}, Session: ${socket.sessionId}`);
    });

    socket.on('message', async (data) => {
      try {
        const { message } = data;
        const sessionId = socket.sessionId;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
          socket.emit('error', { 
            message: 'Invalid message format' 
          });
          return;
        }

        const userMessage = message.trim();
        await createMessage({
          sessionId,
          messageText: userMessage,
          sender: 'user'
        });

        const session = await getSessionBySessionId(sessionId);
        if (!session) {
          socket.emit('error', { message: 'Session not found' });
          return;
        }

        let currentStep = session.current_step;
        let intakeStatus = session.intake_status;

        if (intakeStatus === INTAKE_STATUS.NOT_STARTED || intakeStatus === null || !currentStep) {
          const initialQuestion = getInitialQuestion();
          currentStep = PROBING_STEPS.INITIAL_PROBLEM;
          intakeStatus = INTAKE_STATUS.IN_PROGRESS;
          
          await updateSession(sessionId, {
            intake_status: intakeStatus,
            current_step: currentStep
          });

          await createMessage({
            sessionId,
            messageText: initialQuestion,
            sender: 'system'
          });

          socket.emit('message_response', {
            message: initialQuestion,
            timestamp: new Date().toISOString(),
            sessionId,
            currentStep: currentStep
          });

          return;
        }

        if (intakeStatus === INTAKE_STATUS.IN_PROGRESS && currentStep) {
          const result = await processProbingResponse(sessionId, currentStep, userMessage, session);

          if (result.warning) {
            await createMessage({
              sessionId,
              messageText: result.message,
              sender: 'system'
            });

            socket.emit('message_response', {
              message: result.message,
              timestamp: new Date().toISOString(),
              sessionId,
              type: 'warning'
            });
            return;
          }

          if (result.intakeStatus === INTAKE_STATUS.COMPLETE) {
            const ticketPayload = await generateTicketPayload(sessionId);
            
            // Emit ticket_ready event (for backward compatibility)
            socket.emit('ticket_ready', {
              ticket: ticketPayload,
              timestamp: new Date().toISOString()
            });

            // Automatically submit the ticket
            try {
              const session = await getSessionBySessionId(sessionId);
              const userId = session?.user_id || null;
              
              const submissionResult = await submitTicket(ticketPayload, sessionId, userId);
              
              // Emit ticket_submitted event with reference ID
              socket.emit('ticket_submitted', {
                success: true,
                referenceId: submissionResult.referenceId,
                sessionId: sessionId,
                emailSent: submissionResult.emailSent,
                testMode: submissionResult.testMode || false,
                timestamp: new Date().toISOString()
              });

              await createMessage({
                sessionId,
                messageText: 'Thank you! I have all the information I need. Your support ticket has been submitted successfully.',
                sender: 'system'
              });

              socket.emit('message_response', {
                message: 'Thank you! I have all the information I need. Your support ticket has been submitted successfully.',
                timestamp: new Date().toISOString(),
                sessionId
              });
            } catch (submissionError) {
              // Handle submission errors gracefully
              console.error('Error submitting ticket:', submissionError);
              
              // Still emit ticket_submitted with error info
              socket.emit('ticket_submitted', {
                success: false,
                error: 'Failed to submit ticket. Please contact support directly.',
                sessionId: sessionId,
                timestamp: new Date().toISOString()
              });

              await createMessage({
                sessionId,
                messageText: 'There was an issue submitting your ticket. Please contact support directly with your information.',
                sender: 'system'
              });

              socket.emit('message_response', {
                message: 'There was an issue submitting your ticket. Please contact support directly with your information.',
                timestamp: new Date().toISOString(),
                sessionId,
                type: 'warning'
              });
            }
          } else if (result.question) {
            await createMessage({
              sessionId,
              messageText: result.question,
              sender: 'system'
            });

            socket.emit('message_response', {
              message: result.question,
              timestamp: new Date().toISOString(),
              sessionId,
              currentStep: result.nextStep
            });
          }
        } else if (isIntakeComplete(session)) {
          await createMessage({
            sessionId,
            messageText: 'Your intake is complete. If you need further assistance, please start a new session.',
            sender: 'system'
          });

          socket.emit('message_response', {
            message: 'Your intake is complete. If you need further assistance, please start a new session.',
            timestamp: new Date().toISOString(),
            sessionId
          });
        }
      } catch (error) {
        console.error('Error handling message:', error);
        socket.emit('error', {
          message: 'Failed to process message',
          error: error.message
        });
      }
    });

    socket.on('ping', () => {
      socket.emit('pong', { 
        message: 'Server is alive', 
        timestamp: new Date().toISOString() 
      });
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initSocket first.');
  }
  return io;
};
