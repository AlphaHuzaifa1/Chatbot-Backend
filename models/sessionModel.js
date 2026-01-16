import { query } from '../db/db.js';

export const createSession = async (sessionData) => {
  const { user_name, email, company } = sessionData;
  const sql = `
    INSERT INTO sessions (user_name, email, company, created_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING *
  `;
  const result = await query(sql, [user_name, email, company]);
  return result.rows[0];
};

export const getSessionById = async (sessionId) => {
  const sql = 'SELECT * FROM sessions WHERE id = $1';
  const result = await query(sql, [sessionId]);
  return result.rows[0] || null;
};

export const getAllSessions = async (limit = 100, offset = 0) => {
  const sql = 'SELECT * FROM sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2';
  const result = await query(sql, [limit, offset]);
  return result.rows;
};

export const updateSession = async (sessionId, updates) => {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.user_name) {
    fields.push(`user_name = $${paramIndex++}`);
    values.push(updates.user_name);
  }
  if (updates.email) {
    fields.push(`email = $${paramIndex++}`);
    values.push(updates.email);
  }
  if (updates.company) {
    fields.push(`company = $${paramIndex++}`);
    values.push(updates.company);
  }

  if (fields.length === 0) {
    return null;
  }

  values.push(sessionId);
  const sql = `
    UPDATE sessions
    SET ${fields.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
  `;
  const result = await query(sql, values);
  return result.rows[0] || null;
};

export const deleteSession = async (sessionId) => {
  const sql = 'DELETE FROM sessions WHERE id = $1 RETURNING id';
  const result = await query(sql, [sessionId]);
  return result.rows.length > 0;
};

