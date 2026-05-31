require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const tenantRes = await pool.query(`SELECT learned_rules FROM tenants WHERE name ILIKE '%sai%'`);
    console.log("Learned rules:", tenantRes.rows[0].learned_rules);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
