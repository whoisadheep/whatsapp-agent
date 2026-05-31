require('dotenv').config(); 
const { Pool } = require('pg'); 
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); 
pool.query("DELETE FROM tenants WHERE id IN ('shoply', 'sai_infotek', 'purvodaya')").then(res => { console.log('Deleted demo tenants'); pool.end(); }).catch(e => console.error(e));
