import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from '../db/db.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run a SQL migration file
 */
const runMigration = async (migrationFile) => {
  const migrationPath = join(__dirname, '..', 'db', migrationFile);
  
  console.log(`\n📄 Reading migration file: ${migrationFile}`);
  
  let sql;
  try {
    sql = readFileSync(migrationPath, 'utf8');
  } catch (error) {
    console.error(`❌ Error reading migration file: ${error.message}`);
    process.exit(1);
  }

  console.log(`\n🚀 Executing migration...`);
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    
    console.log(`✅ Migration completed successfully!\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Migration failed: ${error.message}`);
    console.error(`\nError details:`, error);
    process.exit(1);
  } finally {
    client.release();
  }
};

// Get migration file from command line argument
const migrationFile = process.argv[2];

if (!migrationFile) {
  console.log(`
Usage: node scripts/runMigration.js <migration-file>

Example:
  node scripts/runMigration.js migration_add_ai_intake_fields.sql

Available migrations:
  - migration_add_ai_intake_fields.sql (Adds AI intake fields)
  - migration_fix_sessions_table.sql (Fixes sessions table structure)
`);
  process.exit(1);
}

runMigration(migrationFile)
  .then(() => {
    console.log('Migration script completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

