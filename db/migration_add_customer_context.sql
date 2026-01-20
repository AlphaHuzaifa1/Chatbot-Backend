-- Migration: Add customer context fields to sessions table
-- Safe to run multiple times (idempotent)
-- Run this in Supabase SQL Editor

-- Add phone column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'phone'
    ) THEN
        ALTER TABLE sessions ADD COLUMN phone VARCHAR(50);
    END IF;
END $$;

-- Add vsa_agent_name column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'vsa_agent_name'
    ) THEN
        ALTER TABLE sessions ADD COLUMN vsa_agent_name VARCHAR(255);
    END IF;
END $$;

-- Verify columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'sessions' 
AND column_name IN ('phone', 'vsa_agent_name');

