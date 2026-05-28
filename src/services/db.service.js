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
            ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : false,
        });

        // Test connection
        try {
            const client = await this.pool.connect();
            client.release();
            this.connected = true;
            // Add user_id to existing tables if it doesn't exist
            try {
                await this.pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)');
            } catch (err) {
                console.log('user_id column already exists or error:', err.message);
            }

            console.log('✅ Database connected successfully');
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
            `CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                subscription_status VARCHAR(50) DEFAULT 'trialing',
                trial_ends_at TIMESTAMP,
                razorpay_subscription_id VARCHAR(255),
                razorpay_customer_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT NOW()
            )`,
            `CREATE TABLE IF NOT EXISTS tenants (
                id VARCHAR(50) PRIMARY KEY,
                user_id VARCHAR(255),
                name VARCHAR(255) NOT NULL,
                instance_name VARCHAR(255) NOT NULL,
                system_prompt TEXT,
                ignored_numbers TEXT,
                allowed_groups TEXT,
                takeover_timeout_ms INTEGER,
                upi_id VARCHAR(255),
                upi_name VARCHAR(255),
                review_link TEXT,
                owner_phone VARCHAR(20),
                skip_ai BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )`,
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
            `CREATE TABLE IF NOT EXISTS review_requests (
                id SERIAL PRIMARY KEY,
                tenant_id VARCHAR(50) NOT NULL,
                customer_name VARCHAR(255) NOT NULL,
                customer_phone VARCHAR(20) NOT NULL,
                scheduled_for TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            )`,
            // Indexes for faster lookups
            `CREATE INDEX IF NOT EXISTS idx_messages_tenant_phone ON messages(tenant_id, phone)`,
            `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads(tenant_id, phone)`,
            `CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status)`,
            `CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id)`,
            `CREATE INDEX IF NOT EXISTS idx_reviews_status_time ON review_requests(status, scheduled_for)`,
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
        if (!this.connected) {
            console.log('🔄 Database disconnected. Attempting to reconnect...');
            await this.connect();
            if (!this.connected) {
                throw new Error('Database is not connected (reconnection failed)');
            }
        }
        try {
            return await this.pool.query(text, params);
        } catch (error) {
            console.error('❌ DB query error:', error.message);
            throw error;
        }
    }

    isConnected() {
        return this.connected;
    }

    async getUserSubscription(userId) {
        if (!this.connected) return null;
        try {
            const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
            if (res.rows.length === 0) {
                // Auto-create user with 3-day trial if they don't exist
                const trialEndsAt = new Date();
                trialEndsAt.setDate(trialEndsAt.getDate() + 3);
                const insertRes = await this.pool.query(
                    'INSERT INTO users (id, trial_ends_at) VALUES ($1, $2) RETURNING *',
                    [userId, trialEndsAt]
                );
                return insertRes.rows[0];
            }
            return res.rows[0];
        } catch (error) {
            console.error('Error fetching user subscription:', error);
            return null;
        }
    }

    async updateUserSubscription(userId, updates) {
        if (!this.connected) return null;
        try {
            const keys = Object.keys(updates);
            const values = Object.values(updates);
            
            if (keys.length === 0) return null;

            const setClause = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
            
            const query = `
                UPDATE users 
                SET ${setClause}
                WHERE id = $1
                RETURNING *
            `;
            
            const res = await this.pool.query(query, [userId, ...values]);
            return res.rows[0];
        } catch (error) {
            console.error('Error updating user subscription:', error);
            return null;
        }
    }
}

module.exports = new DatabaseService();
