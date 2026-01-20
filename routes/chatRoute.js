import express from 'express';
import { startChat } from '../controllers/chatController.js';
import { validateSharedSecret } from '../middlewares/validateSecret.js';
import { optionalAuthenticate } from '../middlewares/optionalAuth.js';

const router = express.Router();

router.post('/start', validateSharedSecret, optionalAuthenticate, startChat);

export { router as chatRouter };

