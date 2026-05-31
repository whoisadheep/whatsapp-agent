const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:%40kishan~31%2F08@db.sslmozbifqqooeviombu.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await pool.query('ALTER TABLE tenants ADD COLUMN guardrail_enabled BOOLEAN DEFAULT FALSE');
    console.log('Added guardrail_enabled column');
  } catch(e) {
    console.log('guardrail_enabled column might already exist:', e.message);
  }
  
  try {
    await pool.query("ALTER TABLE tenants ADD COLUMN learned_rules TEXT DEFAULT ''");
    console.log('Added learned_rules column');
  } catch(e) {
    console.log('learned_rules column might already exist:', e.message);
  }
  
  process.exit(0);
}

run();
