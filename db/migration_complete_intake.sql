-- Complete migration script for intake system
-- Safe to run multiple times (idempotent)
-- Run this in Supabase SQL Editor

-- Step 1: Drop foreign key constraint if it exists
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;

-- Step 2: Drop user_id column if it exists (we'll recreate it with correct type)
ALTER TABLE sessions DROP COLUMN IF EXISTS user_id;

-- Step 3: Add user_id column with correct UUID type
-- This ensures the column is definitely created before we try to index it
DO $$
BEGIN
    -- If column doesn't exist, create it
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE sessions ADD COLUMN user_id UUID;
    -- If column exists but is wrong type, drop and recreate
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' 
        AND column_name = 'user_id' 
        AND data_type != 'uuid'
    ) THEN
        ALTER TABLE sessions DROP COLUMN user_id;
        ALTER TABLE sessions ADD COLUMN user_id UUID;
    END IF;
END $$;

-- Step 4: Add foreign key constraint if it doesn't exist
DO $$
BEGIN
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

-- Step 5: Add intake_status column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'intake_status'
    ) THEN
        ALTER TABLE sessions ADD COLUMN intake_status VARCHAR(50) DEFAULT 'not_started';
    END IF;
END $$;

-- Step 6: Add current_step column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'current_step'
    ) THEN
        ALTER TABLE sessions ADD COLUMN current_step VARCHAR(50);
    END IF;
END $$;

-- Step 7: Add category column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'category'
    ) THEN
        ALTER TABLE sessions ADD COLUMN category VARCHAR(50);
    END IF;
END $$;

-- Step 8: Set default values for existing sessions (only if column exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'intake_status'
    ) THEN
        UPDATE sessions SET intake_status = 'not_started' WHERE intake_status IS NULL;
    END IF;
END $$;

-- Step 9: Create indexes if they don't exist (only if columns exist with correct type) using dynamic SQL
DO $$
BEGIN
    -- Check intake_status exists and is VARCHAR before creating index
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' 
        AND column_name = 'intake_status' 
        AND data_type = 'character varying'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'idx_sessions_intake_status') THEN
            EXECUTE 'CREATE INDEX idx_sessions_intake_status ON sessions(intake_status)';
        END IF;
    END IF;
    
    -- Check category exists and is VARCHAR before creating index
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' 
        AND column_name = 'category' 
        AND data_type = 'character varying'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'idx_sessions_category') THEN
            EXECUTE 'CREATE INDEX idx_sessions_category ON sessions(category)';
        END IF;
    END IF;
    
    -- Check user_id exists and is UUID before creating index
    -- Skip if column doesn't exist (it's optional)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' 
        AND column_name = 'user_id' 
        AND data_type = 'uuid'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'idx_sessions_user_id') THEN
            BEGIN
                EXECUTE 'CREATE INDEX idx_sessions_user_id ON sessions(user_id)';
            EXCEPTION
                WHEN OTHERS THEN
                    -- If index creation fails (e.g., column doesn't exist), skip it
                    RAISE NOTICE 'Skipping user_id index creation: %', SQLERRM;
            END;
        END IF;
    END IF;
END $$;

-- Step 10: Create intake_responses table if it doesn't exist
CREATE TABLE IF NOT EXISTS intake_responses (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    step VARCHAR(50) NOT NULL,
    response_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 11: Create indexes for intake_responses if they don't exist
CREATE INDEX IF NOT EXISTS idx_intake_responses_session_id ON intake_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_intake_responses_step ON intake_responses(step);

-- Step 12: Verify the migration
SELECT 'Migration completed successfully!' AS status;

SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'sessions' 
AND column_name IN ('user_id', 'intake_status', 'current_step', 'category')
ORDER BY column_name;

SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'intake_responses'
ORDER BY ordinal_position;

