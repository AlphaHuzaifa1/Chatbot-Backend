import { query } from '../db/db.js';

/**
 * Ticket Model
 * Handles database operations for ticket metadata
 * Note: This does NOT store sensitive content or full transcripts
 */

/**
 * Create a new ticket record with minimal metadata
 */
export const createTicket = async (ticketData) => {
  const {
    referenceId,
    sessionId,
    category,
    status = 'submitted',
    emailSent = false,
    emailError = null
  } = ticketData;

  const sql = `
    INSERT INTO tickets (
      reference_id, session_id, category, status, email_sent, email_error, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING id, reference_id, session_id, category, status, email_sent, email_error, created_at, updated_at
  `;

  const result = await query(sql, [
    referenceId,
    sessionId,
    category,
    status,
    emailSent,
    emailError
  ]);

  return result.rows[0];
};

/**
 * Get ticket by reference ID
 */
export const getTicketByReferenceId = async (referenceId) => {
  const sql = 'SELECT * FROM tickets WHERE reference_id = $1';
  const result = await query(sql, [referenceId]);
  return result.rows[0] || null;
};

/**
 * Get ticket by session ID
 */
export const getTicketBySessionId = async (sessionId) => {
  const sql = 'SELECT * FROM tickets WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1';
  const result = await query(sql, [sessionId]);
  return result.rows[0] || null;
};

/**
 * Update ticket status
 */
export const updateTicket = async (referenceId, updates) => {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.emailSent !== undefined) {
    fields.push(`email_sent = $${paramIndex++}`);
    values.push(updates.emailSent);
  }
  if (updates.emailError !== undefined) {
    fields.push(`email_error = $${paramIndex++}`);
    values.push(updates.emailError);
  }

  if (fields.length === 0) {
    return null;
  }

  fields.push(`updated_at = NOW()`);
  values.push(referenceId);

  const sql = `
    UPDATE tickets
    SET ${fields.join(', ')}
    WHERE reference_id = $${paramIndex}
    RETURNING *
  `;

  const result = await query(sql, values);
  return result.rows[0] || null;
};

/**
 * Get all tickets with pagination
 */
export const getAllTickets = async (limit = 100, offset = 0) => {
  const sql = `
    SELECT * FROM tickets 
    ORDER BY created_at DESC 
    LIMIT $1 OFFSET $2
  `;
  const result = await query(sql, [limit, offset]);
  return result.rows;
};

export default {
  createTicket,
  getTicketByReferenceId,
  getTicketBySessionId,
  updateTicket,
  getAllTickets
};
