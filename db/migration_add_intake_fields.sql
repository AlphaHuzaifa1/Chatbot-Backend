-- Migration script to add intake tracking fields to sessions table
-- Run this in Supabase SQL Editor if you have an existing sessions table

-- Step 1: Check if user_id column exists and fix its type if needed
DO $$
BEGIN
    -- Check if user_id column exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'user_id'
    ) THEN
        -- If it exists but is wrong type, drop and recreate
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'sessions' 
            AND column_name = 'user_id' 
            AND data_type != 'uuid'
        ) THEN
            ALTER TABLE sessions DROP COLUMN user_id;
        END IF;
    END IF;
    
    -- Add user_id column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE sessions ADD COLUMN user_id UUID;
    END IF;
    
    -- Add foreign key constraint if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'sessions' 
        AND constraint_name = 'sessions_user_id_fkey'
    ) THEN
        ALTER TABLE sessions 
        ADD CONSTRAINT sessions_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Step 2: Add other new columns if they don't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS intake_status VARCHAR(50) DEFAULT 'not_started',
ADD COLUMN IF NOT EXISTS current_step VARCHAR(50),
ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Step 2: Set default values for existing sessions
UPDATE sessions SET intake_status = 'not_started' WHERE intake_status IS NULL;

-- Step 3: Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_intake_status ON sessions(intake_status);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Step 4: Create intake_responses table if it doesn't exist
CREATE TABLE IF NOT EXISTS intake_responses (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    step VARCHAR(50) NOT NULL,
    response_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 5: Create indexes for intake_responses
CREATE INDEX IF NOT EXISTS idx_intake_responses_session_id ON intake_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_intake_responses_step ON intake_responses(step);

-- Step 6: Verify the migration
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'sessions'
ORDER BY ordinal_position;

SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'intake_responses'
ORDER BY ordinal_position;

