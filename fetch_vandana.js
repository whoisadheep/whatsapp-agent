require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const msgs = await pool.query(`
      SELECT *
      FROM messages 
      WHERE tenant_id = 'sai_infotek' 
      ORDER BY created_at ASC
    `);
    
    // Group by phone
    const chats = {};
    for (const m of msgs.rows) {
        if (!chats[m.phone]) chats[m.phone] = [];
        chats[m.phone].push(m);
    }

    for (const phone of Object.keys(chats)) {
        console.log(`\n=== CHAT FOR ${phone} ===`);
        for (const m of chats[phone]) {
            console.log(`[${m.created_at.toLocaleString()}] ${m.role}: ${m.content}`);
        }
    }
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
