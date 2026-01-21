-- Migration: Add phone, company, and vsa_agent_name fields to users table
-- Date: 2025-01-21

-- Add new columns to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
ADD COLUMN IF NOT EXISTS company VARCHAR(255),
ADD COLUMN IF NOT EXISTS vsa_agent_name VARCHAR(255);

-- Add index for company (useful for filtering)
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company);

-- Update existing users to have null values (already default)
-- No data migration needed as these are new optional fields

COMMENT ON COLUMN users.phone IS 'User phone number';
COMMENT ON COLUMN users.company IS 'User company name';
COMMENT ON COLUMN users.vsa_agent_name IS 'VSA Agent or Device name';

