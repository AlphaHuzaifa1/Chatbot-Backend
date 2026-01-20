import { query } from '../db/db.js';

export const createMessage = async (messageData) => {
  const { sessionId, messageText, sender } = messageData;
  const sql = `
    INSERT INTO messages (session_id, message_text, sender, created_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING *
  `;
  const result = await query(sql, [sessionId, messageText, sender]);
  return result.rows[0];
};

export const getMessagesBySessionId = async (sessionId, limit = 100) => {
  const sql = `
    SELECT * FROM messages 
    WHERE session_id = $1 
    ORDER BY created_at ASC 
    LIMIT $2
  `;
  const result = await query(sql, [sessionId, limit]);
  return result.rows;
};

