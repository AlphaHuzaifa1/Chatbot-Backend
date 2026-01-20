-- Migration script to create tickets table for storing minimal ticket metadata
-- Safe to run multiple times (idempotent)
-- Run this in Supabase SQL Editor
-- This table does NOT store sensitive content or full transcripts

-- Create tickets table if it doesn't exist
CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    reference_id VARCHAR(50) UNIQUE NOT NULL,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    category VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'submitted',
    email_sent BOOLEAN DEFAULT false,
    email_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_tickets_reference_id ON tickets(reference_id);
CREATE INDEX IF NOT EXISTS idx_tickets_session_id ON tickets(session_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);

-- Add table and column comments (PostgreSQL specific)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'tickets') THEN
        COMMENT ON TABLE tickets IS 'Minimal metadata for submitted support tickets. Does not store sensitive content.';
        COMMENT ON COLUMN tickets.reference_id IS 'Human-readable unique reference ID for the ticket';
        COMMENT ON COLUMN tickets.session_id IS 'Reference to the chat session that generated this ticket';
        COMMENT ON COLUMN tickets.status IS 'Ticket status: submitted, failed, or warning (submitted but email failed)';
        COMMENT ON COLUMN tickets.email_sent IS 'Whether the support email was successfully sent';
        COMMENT ON COLUMN tickets.email_error IS 'Error message if email sending failed (null if successful)';
    END IF;
END $$;

-- Verify the migration
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'tickets'
ORDER BY ordinal_position;
