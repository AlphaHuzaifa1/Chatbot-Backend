import { pool } from '../db/db.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Clear all data from all tables
 * WARNING: This will delete ALL data from the database!
 * 
 * Usage: node scripts/clearAllData.js --confirm
 */
const clearAllData = async () => {
  // Require --confirm flag for safety
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');
  
  if (!confirmed) {
    console.log('\n⚠️  WARNING: This will delete ALL data from ALL tables!');
    console.log('\nUsage: node scripts/clearAllData.js --confirm');
    console.log('\nThis will delete data from:');
    console.log('  - messages');
    console.log('  - intake_responses');
    console.log('  - tickets');
    console.log('  - sessions');
    console.log('  - users');
    console.log('\n⚠️  This action cannot be undone!\n');
    process.exit(1);
  }

  const client = await pool.connect();
  
  try {
    console.log('\n🗑️  Starting data deletion...\n');
    
    await client.query('BEGIN');
    
    // Delete in order to respect foreign key constraints
    // Child tables first, then parent tables
    
    console.log('🗑️  Deleting from messages...');
    const messagesResult = await client.query('DELETE FROM messages');
    console.log(`   ✓ Deleted ${messagesResult.rowCount} messages`);
    
    console.log('🗑️  Deleting from intake_responses...');
    const intakeResult = await client.query('DELETE FROM intake_responses');
    console.log(`   ✓ Deleted ${intakeResult.rowCount} intake responses`);
    
    console.log('🗑️  Deleting from tickets...');
    const ticketsResult = await client.query('DELETE FROM tickets');
    console.log(`   ✓ Deleted ${ticketsResult.rowCount} tickets`);
    
    console.log('🗑️  Deleting from sessions...');
    const sessionsResult = await client.query('DELETE FROM sessions');
    console.log(`   ✓ Deleted ${sessionsResult.rowCount} sessions`);
    
    console.log('🗑️  Deleting from users...');
    const usersResult = await client.query('DELETE FROM users');
    console.log(`   ✓ Deleted ${usersResult.rowCount} users`);
    
    await client.query('COMMIT');
    
    console.log('\n✅ All data cleared successfully!');
    console.log('\nSummary:');
    console.log(`   - Messages: ${messagesResult.rowCount}`);
    console.log(`   - Intake Responses: ${intakeResult.rowCount}`);
    console.log(`   - Tickets: ${ticketsResult.rowCount}`);
    console.log(`   - Sessions: ${sessionsResult.rowCount}`);
    console.log(`   - Users: ${usersResult.rowCount}\n`);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error clearing data:', error.message);
    console.error('\nError details:', error);
    process.exit(1);
  } finally {
    client.release();
  }
};

// Run the script
clearAllData()
  .then(() => {
    console.log('Data clearing script completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

