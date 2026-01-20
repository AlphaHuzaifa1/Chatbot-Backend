import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initSocket } from './sockets/socket.js';
import { testRouter } from './routes/testRoute.js';
import { chatRouter } from './routes/chatRoute.js';
import { authRouter } from './routes/authRoute.js';
import { connectDB } from './db/db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

app.use('/api/test', testRouter);
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

const startServer = async () => {
  try {
    await connectDB();
    console.log('Database connected successfully');
  } catch (error) {
    console.warn('Database connection failed. Server will start without database connection.');
    console.warn('Ensure PostgreSQL is running and connection settings are correct in .env file');
  }
  
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  initSocket(server);
  console.log('Socket.io initialized');
};

startServer();

export default app;

