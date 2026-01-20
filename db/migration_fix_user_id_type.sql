-- Migration script to fix user_id type mismatch in sessions table
-- Run this if you're getting the foreign key constraint error

-- Step 1: Drop the foreign key constraint if it exists (with wrong type)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'sessions' 
        AND constraint_name = 'sessions_user_id_fkey'
    ) THEN
        ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey;
    END IF;
END $$;

-- Step 2: Drop user_id column if it exists with wrong type
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE sessions DROP COLUMN user_id;
    END IF;
END $$;

-- Step 3: Add user_id column with correct UUID type
ALTER TABLE sessions ADD COLUMN user_id UUID;

-- Step 4: Add foreign key constraint with correct types
ALTER TABLE sessions 
ADD CONSTRAINT sessions_user_id_fkey 
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Step 5: Add other intake fields if they don't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS intake_status VARCHAR(50) DEFAULT 'not_started',
ADD COLUMN IF NOT EXISTS current_step VARCHAR(50),
ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Step 6: Set default values for existing sessions
UPDATE sessions SET intake_status = 'not_started' WHERE intake_status IS NULL;

-- Step 7: Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_intake_status ON sessions(intake_status);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Step 8: Create intake_responses table if it doesn't exist
CREATE TABLE IF NOT EXISTS intake_responses (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    step VARCHAR(50) NOT NULL,
    response_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 9: Create indexes for intake_responses
CREATE INDEX IF NOT EXISTS idx_intake_responses_session_id ON intake_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_intake_responses_step ON intake_responses(step);

-- Step 10: Verify the migration
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'sessions' AND column_name = 'user_id';

SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'intake_responses'
ORDER BY ordinal_position;

