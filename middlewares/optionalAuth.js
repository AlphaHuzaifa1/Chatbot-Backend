import jwt from 'jsonwebtoken';
import { getUserById } from '../models/userModel.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

export const optionalAuthenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.substring(7);
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await getUserById(decoded.userId);
      
      if (user) {
        req.user = {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          status: user.status
        };
      } else {
        req.user = null;
      }
    } catch (error) {
      if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
        req.user = null;
      } else {
        console.error('Optional auth error:', error);
        req.user = null;
      }
    }
    
    next();
  } catch (error) {
    console.error('Optional authentication error:', error);
    req.user = null;
    next();
  }
};

