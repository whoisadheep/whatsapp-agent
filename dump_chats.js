const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:%40kishan~31%2F08@db.sslmozbifqqooeviombu.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  // Get all unique phone numbers for sai_infotek
  const phones = await pool.query(
    "SELECT DISTINCT phone FROM messages WHERE tenant_id = 'sai_infotek' ORDER BY phone"
  );
  
  console.log(`Found ${phones.rows.length} unique conversations.\n`);
  
  for (const row of phones.rows) {
    const msgs = await pool.query(
      "SELECT role, content, created_at FROM messages WHERE tenant_id = 'sai_infotek' AND phone = $1 ORDER BY created_at ASC",
      [row.phone]
    );
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`CONVERSATION WITH: ${row.phone} (${msgs.rows.length} messages)`);
    console.log(`${'='.repeat(80)}`);
    
    for (const m of msgs.rows) {
      const time = new Date(m.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const label = m.role === 'user' ? '👤 CUSTOMER' : '🤖 AI';
      console.log(`\n[${time}] ${label}:`);
      console.log(m.content);
    }
  }
  
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
