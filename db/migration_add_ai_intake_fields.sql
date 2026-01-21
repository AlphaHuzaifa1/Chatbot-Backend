-- Migration: Add AI-driven intake fields to sessions table
-- This migration adds fields for the new AI-driven intake system

-- Add new intake fields
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS issue TEXT,
ADD COLUMN IF NOT EXISTS urgency VARCHAR(50),
ADD COLUMN IF NOT EXISTS affected_system TEXT,
ADD COLUMN IF NOT EXISTS error_text TEXT,
ADD COLUMN IF NOT EXISTS submitted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS asked_questions JSONB DEFAULT '[]'::jsonb;

-- Update existing sessions: migrate data from intake_responses if needed
-- This is a one-time migration for existing data
DO $$
DECLARE
    session_record RECORD;
    initial_problem TEXT;
    urgency_response TEXT;
    affected_system_response TEXT;
    error_message_response TEXT;
BEGIN
    FOR session_record IN SELECT session_id FROM sessions WHERE intake_status = 'complete' LOOP
        -- Try to extract data from intake_responses
        SELECT response_text INTO initial_problem 
        FROM intake_responses 
        WHERE session_id = session_record.session_id AND step = 'initial_problem' 
        LIMIT 1;
        
        SELECT response_text INTO urgency_response 
        FROM intake_responses 
        WHERE session_id = session_record.session_id AND step = 'urgency_impact' 
        LIMIT 1;
        
        SELECT response_text INTO affected_system_response 
        FROM intake_responses 
        WHERE session_id = session_record.session_id AND step = 'affected_system' 
        LIMIT 1;
        
        SELECT response_text INTO error_message_response 
        FROM intake_responses 
        WHERE session_id = session_record.session_id AND step = 'error_message' 
        LIMIT 1;
        
        -- Update session with extracted data
        UPDATE sessions 
        SET 
            issue = COALESCE(initial_problem, issue),
            urgency = CASE 
                WHEN urgency_response ILIKE '%blocked%' OR urgency_response ILIKE '%critical%' THEN 'blocked'
                WHEN urgency_response ILIKE '%degraded%' OR urgency_response ILIKE '%high%' THEN 'degraded'
                WHEN urgency_response ILIKE '%minor%' OR urgency_response ILIKE '%low%' THEN 'minor'
                ELSE urgency
            END,
            affected_system = COALESCE(affected_system_response, affected_system),
            error_text = COALESCE(error_message_response, error_text),
            submitted = (intake_status = 'complete')
        WHERE session_id = session_record.session_id;
    END LOOP;
END $$;

-- Create indexes for new fields
CREATE INDEX IF NOT EXISTS idx_sessions_urgency ON sessions(urgency);
CREATE INDEX IF NOT EXISTS idx_sessions_submitted ON sessions(submitted);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);

-- Add comment to table
COMMENT ON COLUMN sessions.issue IS 'Main issue description extracted by AI';
COMMENT ON COLUMN sessions.urgency IS 'Urgency level: blocked, degraded, or minor';
COMMENT ON COLUMN sessions.affected_system IS 'System/application/device affected';
COMMENT ON COLUMN sessions.error_text IS 'Error message or "no error provided"';
COMMENT ON COLUMN sessions.submitted IS 'Whether ticket has been submitted';

