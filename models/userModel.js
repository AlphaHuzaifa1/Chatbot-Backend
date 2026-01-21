import { query } from '../db/db.js';

export const createUser = async (userData) => {
  const { email, passwordHash, fullName, phone, company, vsaAgentName } = userData;
  const sql = `
    INSERT INTO users (full_name, email, password_hash, phone, company, vsa_agent_name, role, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'user', 'active', NOW(), NOW())
    RETURNING id, full_name, email, phone, company, vsa_agent_name, role, status, created_at, updated_at
  `;
  const result = await query(sql, [
    fullName || null, 
    email, 
    passwordHash,
    phone || null,
    company || null,
    vsaAgentName || null
  ]);
  return result.rows[0];
};

export const getUserByEmail = async (email) => {
  const sql = 'SELECT * FROM users WHERE email = $1';
  const result = await query(sql, [email]);
  return result.rows[0] || null;
};

export const getUserById = async (id) => {
  const sql = 'SELECT id, full_name, email, phone, company, vsa_agent_name, role, status, created_at, updated_at FROM users WHERE id = $1';
  const result = await query(sql, [id]);
  return result.rows[0] || null;
};

