-- Complete migration for sessions table
-- Run this entire script at once in Supabase SQL Editor

-- Step 1: Drop broken constraint if it exists
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;

-- Step 2: Drop user_id column if it exists (we'll recreate it with correct type)
ALTER TABLE sessions DROP COLUMN IF EXISTS user_id;

-- Step 3: Add user_id column with correct type (INTEGER to match users.id)
ALTER TABLE sessions ADD COLUMN user_id INTEGER;

-- Step 4: Add all other missing columns
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS intake_status VARCHAR(50) DEFAULT 'not_started';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_step VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vsa_agent_name VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Step 5: Add foreign key constraint back
ALTER TABLE sessions 
ADD CONSTRAINT sessions_user_id_fkey 
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Step 6: Update existing rows
UPDATE sessions SET intake_status = 'not_started' WHERE intake_status IS NULL;

-- Step 7: Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_intake_status ON sessions(intake_status);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);

-- Done! All columns should now exist.
