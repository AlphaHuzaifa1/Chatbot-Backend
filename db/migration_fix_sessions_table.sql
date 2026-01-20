-- Comprehensive migration to fix sessions table
-- Adds all missing columns that the application expects
-- Safe to run multiple times (idempotent)
-- Run this in Supabase SQL Editor or your PostgreSQL database

-- Step 1: Drop any existing broken foreign key constraint for user_id
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

-- Step 2: Add user_id column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE sessions ADD COLUMN user_id UUID;
    END IF;
END $$;

-- Step 3: Add foreign key constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'sessions' 
        AND constraint_name = 'sessions_user_id_fkey'
    ) THEN
        -- Only add constraint if users table exists
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
            ALTER TABLE sessions 
            ADD CONSTRAINT sessions_user_id_fkey 
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

-- Step 4: Add intake_status column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS intake_status VARCHAR(50) DEFAULT 'not_started';

-- Step 5: Add current_step column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS current_step VARCHAR(50);

-- Step 6: Add category column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Step 7: Add phone column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- Step 8: Add vsa_agent_name column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS vsa_agent_name VARCHAR(255);

-- Step 9: Add updated_at column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Step 10: Set default values for existing rows
UPDATE sessions 
SET intake_status = 'not_started' 
WHERE intake_status IS NULL;

-- Step 11: Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_intake_status ON sessions(intake_status);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);

-- Step 12: Verify the migration
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns 
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
