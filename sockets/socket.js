import { Server } from 'socket.io';
import { getSessionBySessionId } from '../models/sessionModel.js';
import { processMessage } from '../services/aiChatService.js';
import { loadSessionState, createSessionState } from '../services/sessionStateService.js';

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

        // Load or create session state
        let sessionState = await loadSessionState(sessionId);
        if (!sessionState) {
          // Create initial session state from database session
          const dbSession = await getSessionBySessionId(sessionId);
          if (!dbSession) {
            socket.emit('error', { message: 'Session not found' });
            return;
          }
          sessionState = await createSessionState(sessionId, {
            fullName: dbSession.user_name,
            email: dbSession.email,
            phone: dbSession.phone,
            company: dbSession.company,
            vsaAgent: dbSession.vsa_agent_name
          });
        }

        // Process message with AI (AI will handle greeting if needed)
        const response = await processMessage(sessionId, userMessage);

        // Handle response
        if (response.sensitive) {
          socket.emit('message_response', {
            message: response.message,
            timestamp: new Date().toISOString(),
            sessionId,
            type: 'warning'
          });
          return;
        }

        if (response.submitted) {
          // Ticket submitted
          socket.emit('ticket_submitted', {
            success: true,
            referenceId: response.referenceId,
            sessionId: sessionId,
            emailSent: response.emailSent,
            testMode: response.testMode || false,
            timestamp: new Date().toISOString()
          });

          socket.emit('message_response', {
            message: response.message,
            timestamp: new Date().toISOString(),
            sessionId,
            type: 'success'
          });
          return;
        }

        if (response.error) {
          socket.emit('error', {
            message: response.message,
            error: response.error
          });
          return;
        }

        // Regular response
        socket.emit('message_response', {
          message: response.message,
          timestamp: new Date().toISOString(),
          sessionId,
          type: response.type || 'question',
          readyToSubmit: response.readyToSubmit || false
        });

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
