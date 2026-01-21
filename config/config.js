
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'support_chatbot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
  },
  socketio: {
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 60000,
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000
  },
  app: {
    name: process.env.APP_NAME || 'Support ChatBot',
    version: process.env.APP_VERSION || '1.0.0'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },
  security: {
    testMode: process.env.TEST_MODE === 'true',
    enableLogging: process.env.ENABLE_LOGGING !== 'false',
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 10
  }
};

