const db = require('./db.service');
const evolutionService = require('./evolution.service');
const tenantService = require('./tenant.service');

class ReviewService {
    constructor() {
        this.timers = new Map();
        this.summaryTimer = null;
    }

    async init() {
        if (!db.isConnected()) return;

        console.log('🔄 Initializing Review Booster Service...');

        try {
            const result = await db.query(
                "SELECT * FROM review_requests WHERE status = 'pending' AND scheduled_for > NOW() - INTERVAL '1 hour'"
            );

            if (result && result.rows.length > 0) {
                console.log(`⏳ Found ${result.rows.length} pending review requests. Re-scheduling...`);
                for (const row of result.rows) {
                    this._scheduleTimeout(row);
                }
            }
        } catch (error) {
            console.error('❌ Failed to hydrate review requests:', error.message);
        }

        this._setupDailyCron();
    }

    /**
     * Check if a review request was already sent/scheduled for this customer
     * within the last N days — prevents spam from multiple conversation closings.
     * @param {string} tenantId
     * @param {string} customerPhone
     * @param {number} withinDays - cooldown window (default 30 days)
     * @returns {boolean} true if already requested recently
     */
    async wasRecentlyRequested(tenantId, customerPhone, withinDays = 30) {
        if (!db.isConnected()) return false;

        const result = await db.query(
            `SELECT id FROM review_requests
             WHERE tenant_id = $1
               AND customer_phone = $2
               AND status IN ('pending', 'sent')
               AND created_at >= NOW() - INTERVAL '${withinDays} days'
             LIMIT 1`,
            [tenantId, customerPhone]
        );

        return result && result.rows.length > 0;
    }

    /**
     * Schedule a new review request.
     * Includes dedup guard — skips if already requested within cooldown window.
     * @param {string} tenantId
     * @param {string} customerName
     * @param {string} customerPhone
     * @param {boolean} skipDedup - set true to force (e.g. manual #review command)
     */
    async scheduleReview(tenantId, customerName, customerPhone, skipDedup = false) {
        if (!db.isConnected()) {
            console.error('⚠️ Database not connected. Cannot persist review request.');
            return false;
        }

        // Dedup guard — don't spam the same customer within 30 days
        if (!skipDedup) {
            const alreadyRequested = await this.wasRecentlyRequested(tenantId, customerPhone);
            if (alreadyRequested) {
                console.log(`⏭️  Review request skipped for ${customerPhone} on ${tenantId} — already requested within 30 days.`);
                return false;
            }
        }

        try {
            const delayHours = 1;

            const result = await db.query(
                `INSERT INTO review_requests (tenant_id, customer_name, customer_phone, scheduled_for, status)
                 VALUES ($1, $2, $3, NOW() + INTERVAL '${delayHours} hour', 'pending') RETURNING *`,
                [tenantId, customerName, customerPhone]
            );

            if (result && result.rows[0]) {
                const row = result.rows[0];
                this._scheduleTimeout(row);
                console.log(`🗓️ Review request scheduled for ${customerName} (${customerPhone}) in ${delayHours} hour(s).`);
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Failed to schedule review:', error.message);
            return false;
        }
    }

    _scheduleTimeout(row) {
        const scheduledTime = new Date(row.scheduled_for).getTime();
        const now = Date.now();
        const delayMs = Math.max(0, scheduledTime - now);

        const timerId = setTimeout(async () => {
            this.timers.delete(row.id);
            await this._sendReviewMessage(row);
        }, delayMs);

        this.timers.set(row.id, timerId);
    }

    async _sendReviewMessage(row) {
        try {
            const tenant = tenantService.getTenantById(row.tenant_id);
            if (!tenant || !tenant.reviewLink) {
                console.error(`⚠️ Missing tenant or reviewLink for ${row.tenant_id}`);
                return;
            }

            const message = `Hi ${row.customer_name}, thanks for visiting us!\n\nIf you had a great experience, please take a moment to leave us a 5-star review here: ${tenant.reviewLink}\n\nWe appreciate your support!`;
            const targetNumber = row.customer_phone.replace(/\D/g, '');

            console.log(`📤 Sending review request to ${targetNumber} for ${tenant.name}`);
            await evolutionService.sendText(tenant.instanceName, targetNumber, message);

            if (db.isConnected()) {
                await db.query(
                    `UPDATE review_requests SET status = 'sent' WHERE id = $1`,
                    [row.id]
                );
            }
        } catch (error) {
            console.error(`❌ Failed to send review to ${row.customer_phone}:`, error.message);
            if (db.isConnected()) {
                await db.query(
                    `UPDATE review_requests SET status = 'failed' WHERE id = $1`,
                    [row.id]
                );
            }
        }
    }

    _setupDailyCron() {
        const now = new Date();
        let next8PM = new Date();
        next8PM.setHours(20, 0, 0, 0);

        if (now.getTime() >= next8PM.getTime()) {
            next8PM.setDate(next8PM.getDate() + 1);
        }

        const delayMs = next8PM.getTime() - now.getTime();
        console.log(`⏰ Daily review summary scheduled for ${next8PM.toLocaleString()}`);

        if (this.summaryTimer) clearTimeout(this.summaryTimer);

        this.summaryTimer = setTimeout(async () => {
            await this._sendDailySummaries();
            this._setupDailyCron();
        }, delayMs);
    }

    async _sendDailySummaries() {
        if (!db.isConnected()) return;

        console.log('📊 Generating daily review summaries...');
        try {
            const result = await db.query(
                `SELECT tenant_id, COUNT(*) as count
                 FROM review_requests
                 WHERE status = 'sent'
                   AND created_at >= CURRENT_DATE
                 GROUP BY tenant_id`
            );

            const sentStats = {};
            if (result && result.rows) {
                result.rows.forEach(r => { sentStats[r.tenant_id] = parseInt(r.count, 10); });
            }

            const tenants = tenantService.getAllTenants();
            for (const tenant of tenants) {
                const count = sentStats[tenant.id] || 0;
                if (!tenant.ownerPhone) continue;

                const message = `📈 *Google Review Booster Summary*\n\nToday, ${count} review request(s) were automatically sent to your customers!`;
                await evolutionService.sendText(tenant.instanceName, tenant.ownerPhone.replace(/\D/g, ''), message);
                console.log(`📤 Sent daily summary to ${tenant.name}: ${count} requests.`);
            }
        } catch (error) {
            console.error('❌ Failed to send daily summaries:', error.message);
        }
    }
}

module.exports = new ReviewService();