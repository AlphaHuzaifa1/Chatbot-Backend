import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createUser, getUserByEmail } from '../models/userModel.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

export const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
};

export const registerUser = async (userData) => {
  const { email, password, fullName } = userData;
  
  const existingUser = await getUserByEmail(email);
  if (existingUser) {
    throw new Error('User with this email already exists');
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({
    email: email.toLowerCase().trim(),
    passwordHash,
    fullName: fullName || null
  });

  return user;
};

export const authenticateUser = async (email, password) => {
  const user = await getUserByEmail(email.toLowerCase().trim());
  
  if (!user) {
    throw new Error('Invalid email or password');
  }

  if (user.status !== 'active') {
    throw new Error('Account is not active');
  }

  const isPasswordValid = await comparePassword(password, user.password_hash);
  if (!isPasswordValid) {
    throw new Error('Invalid email or password');
  }

  return user;
};

