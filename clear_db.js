require('dotenv').config();
const { Pool } = require('pg');

async function clearDatabase() {
    const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/shoply_agent';
    
    const pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 5000,
    });

    console.log('Connecting to database...');
    
    try {
        const client = await pool.connect();
        
        console.log('Clearing all tables...');
        
        // Truncate all known tables to clear them completely
        await client.query(`
            TRUNCATE TABLE 
                customers, 
                messages, 
                products, 
                takeover_state, 
                leads, 
                review_requests 
            RESTART IDENTITY CASCADE;
        `);
        
        console.log('✅ Database successfully cleared! Everything is new.');
        
        client.release();
    } catch (error) {
        console.error('❌ Failed to clear database. Make sure PostgreSQL is running.');
        console.error(error.message);
    } finally {
        await pool.end();
    }
}

clearDatabase();
