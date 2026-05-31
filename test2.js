const { Client } = require('pg');
const client = new Client('postgresql://postgres.sslmozbifqqooeviombu:%40kishan~31%2F08@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres');
client.connect().then(() => {
    client.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 5").then(res => {
        console.log(res.rows);
        client.end();
    });
});
