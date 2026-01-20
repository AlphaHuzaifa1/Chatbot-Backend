-- Simple step-by-step migration to fix sessions table
-- Run each section separately if you get errors

-- STEP 1: Drop broken constraint if it exists
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;

-- STEP 2: Add all missing columns (one at a time)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS intake_status VARCHAR(50) DEFAULT 'not_started';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_step VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vsa_agent_name VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- STEP 3: Add foreign key constraint (only if users table exists)
ALTER TABLE sessions 
ADD CONSTRAINT sessions_user_id_fkey 
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- STEP 4: Set default values
UPDATE sessions SET intake_status = 'not_started' WHERE intake_status IS NULL;

-- STEP 5: Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_intake_status ON sessions(intake_status);
CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category);

-- STEP 6: Verify
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
