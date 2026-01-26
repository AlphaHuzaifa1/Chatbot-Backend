-- Migration: Add state persistence columns to sessions table
-- Persists conversationState, submissionApproved, submissionDeclined, confidenceByField

ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS conversation_state VARCHAR(50) DEFAULT 'INIT',
ADD COLUMN IF NOT EXISTS submission_approved BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS submission_declined BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS confidence_by_field JSONB DEFAULT '{}'::jsonb;

-- Create index for conversation_state
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_state ON sessions(conversation_state);

-- Add comments
COMMENT ON COLUMN sessions.conversation_state IS 'Current conversation state machine state';
COMMENT ON COLUMN sessions.submission_approved IS 'User explicitly approved submission';
COMMENT ON COLUMN sessions.submission_declined IS 'User explicitly declined submission';
COMMENT ON COLUMN sessions.confidence_by_field IS 'Confidence scores for extracted fields (JSONB)';

