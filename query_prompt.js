const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:%40kishan~31%2F08@db.sslmozbifqqooeviombu.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

pool.query("SELECT system_prompt FROM tenants WHERE id = 'sai_infotek'")
  .then(res => {
    console.log("PROMPT:\n", res.rows[0].system_prompt);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
