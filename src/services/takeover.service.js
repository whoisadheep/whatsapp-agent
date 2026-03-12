const db = require('./db.service');

// Default timeout: 30 minutes (in ms)
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

class TakeoverService {
    constructor() {
        // Map<`${tenantId}:${phoneNumber}`, { pausedAt: timestamp, timeout: ms | null }>
        // timeout = null means paused indefinitely (until manually resumed)
        this.pausedChats = new Map();
    }

    /**
     * Load active takeovers from DB on startup.
     */
    async loadFromDb() {
        if (!db.isConnected()) return;

        const result = await db.query('SELECT * FROM takeover_state');
        if (result && result.rows.length > 0) {
            for (const row of result.rows) {
                const pausedAt = new Date(row.paused_at).getTime();
                const timeout = row.timeout_ms;
                const cacheKey = `${row.tenant_id}:${row.phone}`;

                // Check if still valid (not expired)
                if (timeout === null || (Date.now() - pausedAt) < timeout) {
                    this.pausedChats.set(cacheKey, { pausedAt, timeout });
                } else {
                    // Expired, clean up from DB
                    db.query('DELETE FROM takeover_state WHERE tenant_id = $1 AND phone = $2', [row.tenant_id, row.phone]);
                }
            }
            console.log(`🔄 Loaded ${this.pausedChats.size} active takeover states from DB`);
        }
    }

    /**
     * Pause AI for a specific contact.
     */
    pause(tenant, phoneNumber, timeoutMs = undefined) {
        const timeout = timeoutMs === null
            ? null
            : (timeoutMs ?? tenant.takeoverTimeoutMs);

        const cacheKey = `${tenant.id}:${phoneNumber}`;

        this.pausedChats.set(cacheKey, {
            pausedAt: Date.now(),
            timeout,
        });

        const durationText = timeout === null
            ? 'indefinitely'
            : `for ${Math.round(timeout / 60000)} minutes`;

        console.log(`🛑 AI paused for ${phoneNumber} ${durationText} on tenant ${tenant.id}`);

        // Persist to DB
        if (db.isConnected()) {
            db.query(
                `INSERT INTO takeover_state (tenant_id, phone, paused_at, timeout_ms)
                 VALUES ($1, $2, NOW(), $3)
                 ON CONFLICT (tenant_id, phone) DO UPDATE SET
                     paused_at = NOW(),
                     timeout_ms = $3`,
                [tenant.id, phoneNumber, timeout]
            );
        }
    }

    /**
     * Resume AI for a specific contact.
     */
    resume(tenantId, phoneNumber) {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        this.pausedChats.delete(cacheKey);
        console.log(`▶️  AI resumed for ${phoneNumber} on tenant ${tenantId}`);

        // Remove from DB
        if (db.isConnected()) {
            db.query('DELETE FROM takeover_state WHERE tenant_id = $1 AND phone = $2', [tenantId, phoneNumber]);
        }
    }

    /**
     * Check if AI is currently paused for a given contact.
     */
    isPaused(tenantId, phoneNumber) {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        const entry = this.pausedChats.get(cacheKey);
        if (!entry) return false;

        // Indefinite pause (owner used #ai off)
        if (entry.timeout === null) return true;

        // Check if timeout has expired
        const elapsed = Date.now() - entry.pausedAt;
        if (elapsed >= entry.timeout) {
            this.pausedChats.delete(cacheKey);
            console.log(`⏰ AI auto-resumed for ${phoneNumber} on tenant ${tenantId} (timeout expired)`);
            // Clean up DB
            if (db.isConnected()) {
                db.query('DELETE FROM takeover_state WHERE tenant_id = $1 AND phone = $2', [tenantId, phoneNumber]);
            }
            return false;
        }

        return true;
    }

    /**
     * Get remaining pause time in minutes for a contact.
     */
    getRemainingTime(tenantId, phoneNumber) {
        const cacheKey = `${tenantId}:${phoneNumber}`;
        const entry = this.pausedChats.get(cacheKey);
        if (!entry) return 'not paused';
        if (entry.timeout === null) return 'paused indefinitely';

        const remaining = entry.timeout - (Date.now() - entry.pausedAt);
        return `${Math.ceil(remaining / 60000)} minutes remaining`;
    }

    getPausedCount() {
        return this.pausedChats.size;
    }
}

module.exports = new TakeoverService();
