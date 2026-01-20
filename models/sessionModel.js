import { query } from '../db/db.js';

export const createSession = async (customerContext = {}, userId = null) => {
  const {
    fullName = null,
    email = null,
    phone = null,
    companyName = null,
    vsaAgentName = null
  } = customerContext;

  try {
    const sql = `
      INSERT INTO sessions (
        session_id, user_id, user_name, email, company, phone, vsa_agent_name,
        status, intake_status, created_at
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active', 'not_started', NOW()
      )
      RETURNING session_id, user_id, user_name, email, company, phone, vsa_agent_name,
                status, intake_status, current_step, category, created_at
    `;
    const result = await query(sql, [userId, fullName, email, companyName, phone, vsaAgentName]);
    return result.rows[0];
  } catch (error) {
    // Fallback for missing columns
    if (error.code === '42703') {
      const sql = `
        INSERT INTO sessions (session_id, user_name, email, company, status, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'active', NOW())
        RETURNING session_id, user_name, email, company, status, created_at
      `;
      const result = await query(sql, [fullName, email, companyName]);
      return {
        ...result.rows[0],
        user_id: userId,
        phone: phone,
        vsa_agent_name: vsaAgentName,
        intake_status: 'not_started',
        current_step: null,
        category: null
      };
    }
    throw error;
  }
};

export const getSessionBySessionId = async (sessionId) => {
  const sql = 'SELECT * FROM sessions WHERE session_id = $1';
  const result = await query(sql, [sessionId]);
  return result.rows[0] || null;
};

export const updateSession = async (sessionId, updates) => {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.user_id !== undefined) {
    fields.push(`user_id = $${paramIndex++}`);
    values.push(updates.user_id);
  }
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
  if (updates.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(updates.phone);
  }
  if (updates.vsa_agent_name !== undefined) {
    fields.push(`vsa_agent_name = $${paramIndex++}`);
    values.push(updates.vsa_agent_name);
  }
  if (updates.status) {
    fields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.intake_status) {
    fields.push(`intake_status = $${paramIndex++}`);
    values.push(updates.intake_status);
  }
  if (updates.current_step) {
    fields.push(`current_step = $${paramIndex++}`);
    values.push(updates.current_step);
  }
  if (updates.category) {
    fields.push(`category = $${paramIndex++}`);
    values.push(updates.category);
  }

  if (fields.length === 0) {
    return null;
  }

  fields.push(`updated_at = NOW()`);
  values.push(sessionId);
  const sql = `
    UPDATE sessions
    SET ${fields.join(', ')}
    WHERE session_id = $${paramIndex}
    RETURNING *
  `;
  const result = await query(sql, values);
  return result.rows[0] || null;
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

export const deleteSession = async (sessionId) => {
  const sql = 'DELETE FROM sessions WHERE session_id = $1 RETURNING session_id';
  const result = await query(sql, [sessionId]);
  return result.rows.length > 0;
};
