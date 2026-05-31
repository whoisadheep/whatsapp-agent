const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:%40kishan~31%2F08@db.sslmozbifqqooeviombu.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT m.*, t.name as tenant_name FROM messages m JOIN tenants t ON m.tenant_id = t.id ORDER BY m.created_at DESC LIMIT 20')
  .then(res => {
    res.rows.forEach(r => {
      console.log(`[${r.tenant_name}] ${r.sender_number} (${r.role}): ${r.content.substring(0, 100).replace(/\n/g, ' ')}`);
    });
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
