import { query } from '../db/db.js';

export const createIntakeResponse = async (sessionId, step, responseText) => {
  const sql = `
    INSERT INTO intake_responses (session_id, step, response_text, created_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING id, session_id, step, response_text, created_at
  `;
  const result = await query(sql, [sessionId, step, responseText]);
  return result.rows[0];
};

export const getIntakeResponsesBySessionId = async (sessionId) => {
  const sql = `
    SELECT step, response_text, created_at
    FROM intake_responses
    WHERE session_id = $1
    ORDER BY created_at ASC
  `;
  const result = await query(sql, [sessionId]);
  return result.rows;
};

export const getIntakeResponsesAsObject = async (sessionId) => {
  const responses = await getIntakeResponsesBySessionId(sessionId);
  const responseObject = {};
  responses.forEach(row => {
    responseObject[row.step] = row.response_text;
  });
  return responseObject;
};

