const db = require('./db.service');

const MAX_HISTORY = 20;
const TTL_MS = 60 * 60 * 1000; // 1 hour

class ConversationService {
    constructor() {
        // In-memory cache: Map<phoneNumber, { messages: [], lastActivity: timestamp }>
        this.conversations = new Map();

        // Cleanup stale conversations every 10 minutes
        setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }

    /**
     * Load conversation history from DB if not in memory cache.
     */
    async loadFromDb(tenantId, phoneNumber) {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        if (this.conversations.has(cacheKey)) return;
        if (!db.isConnected()) return;

        const result = await db.query(
            'SELECT role, content FROM messages WHERE tenant_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT $3',
            [tenantId, phoneNumber, MAX_HISTORY]
        );

        if (result && result.rows.length > 0) {
            // Rows come in DESC order, reverse for chronological
            const messages = result.rows.reverse().map(r => ({
                role: r.role,
                content: r.content,
            }));
            this.conversations.set(cacheKey, {
                messages,
                lastActivity: Date.now(),
            });
        }
    }

    async getHistory(tenantId, phoneNumber) {
        await this.loadFromDb(tenantId, phoneNumber);
        const cacheKey = `${tenantId}:${phoneNumber}`;
        const convo = this.conversations.get(cacheKey);
        if (!convo) return [];
        return convo.messages;
    }

    async addMessage(tenantId, phoneNumber, role, content, pushName = 'Customer') {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        if (!this.conversations.has(cacheKey)) {
            this.conversations.set(cacheKey, {
                messages: [],
                lastActivity: Date.now(),
            });
        }

        const convo = this.conversations.get(cacheKey);
        convo.messages.push({ role, content });
        convo.lastActivity = Date.now();

        // Keep only last N messages in memory
        if (convo.messages.length > MAX_HISTORY) {
            convo.messages = convo.messages.slice(-MAX_HISTORY);
        }

        // Persist to DB (fire-and-forget, don't block the response)
        if (db.isConnected()) {
            db.query(
                'INSERT INTO messages (tenant_id, phone, role, content) VALUES ($1, $2, $3, $4)',
                [tenantId, phoneNumber, role, content]
            );

            // Upsert customer record
            if (role === 'user') {
                db.query(
                    `INSERT INTO customers (tenant_id, phone, push_name, message_count)
                     VALUES ($1, $2, $3, 1)
                     ON CONFLICT (tenant_id, phone) DO UPDATE SET
                         push_name = $3,
                         last_seen = NOW(),
                         message_count = customers.message_count + 1`,
                    [tenantId, phoneNumber, pushName]
                );
            }
        }
    }

    clearHistory(tenantId, phoneNumber) {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        this.conversations.delete(cacheKey);
    }

    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [phone, convo] of this.conversations) {
            if (now - convo.lastActivity > TTL_MS) {
                this.conversations.delete(phone);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} stale conversations from memory cache`);
        }
    }

    getActiveCount() {
        return this.conversations.size;
    }
}

module.exports = new ConversationService();
