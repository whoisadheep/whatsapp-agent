const { Pool } = require('pg');

class DatabaseService {
    constructor() {
        this.pool = null;
        this.connected = false;
    }

    async connect() {
        const connectionString = process.env.DATABASE_URL ||
            'postgresql://postgres:postgres@localhost:5432/shoply_agent';

        this.pool = new Pool({
            connectionString,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        // Test connection
        try {
            const client = await this.pool.connect();
            client.release();
            this.connected = true;
            console.log('🗄️  Database connected successfully');
        } catch (error) {
            console.error('❌ Database connection failed:', error.message);
            console.log('   The agent will work without persistence (in-memory only)');
            this.connected = false;
            return;
        }

        // Create tables
        await this.createTables();
    }

    async createTables() {
        const queries = [
            `CREATE TABLE IF NOT EXISTS customers (
                tenant_id VARCHAR(50) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                push_name VARCHAR(255) DEFAULT 'Customer',
                first_seen TIMESTAMP DEFAULT NOW(),
                last_seen TIMESTAMP DEFAULT NOW(),
                message_count INTEGER DEFAULT 0,
                PRIMARY KEY (tenant_id, phone)
            )`,
            `CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                tenant_id VARCHAR(50) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                role VARCHAR(10) NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )`,
            `CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                tenant_id VARCHAR(50) NOT NULL,
                name VARCHAR(255) NOT NULL,
                price VARCHAR(50),
                description TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )`,
            `CREATE TABLE IF NOT EXISTS takeover_state (
                tenant_id VARCHAR(50) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                paused_at TIMESTAMP DEFAULT NOW(),
                timeout_ms INTEGER,
                PRIMARY KEY (tenant_id, phone)
            )`,
            `CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                tenant_id VARCHAR(50) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                name VARCHAR(255) DEFAULT 'Unknown',
                interest TEXT,
                status VARCHAR(20) DEFAULT 'new',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )`,
            // Indexes for faster lookups
            `CREATE INDEX IF NOT EXISTS idx_messages_tenant_phone ON messages(tenant_id, phone)`,
            `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads(tenant_id, phone)`,
            `CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status)`,
            `CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id)`,
        ];

        try {
            for (const query of queries) {
                await this.pool.query(query);
            }
            console.log('✅ Database tables ready');
        } catch (error) {
            console.error('❌ Failed to create tables:', error.message);
        }
    }

    async query(text, params) {
        if (!this.connected) return null;
        try {
            return await this.pool.query(text, params);
        } catch (error) {
            console.error('❌ DB query error:', error.message);
            return null;
        }
    }

    isConnected() {
        return this.connected;
    }
}

module.exports = new DatabaseService();
