const db = require('./db.service');
const evolutionService = require('./evolution.service');
const tenantService = require('./tenant.service');

class ReviewService {
    constructor() {
        this.timers = new Map(); // Store timeouts for pending reviews
        this.summaryTimer = null;
    }

    async init() {
        if (!db.isConnected()) return;

        console.log('🔄 Initializing Review Booster Service...');

        // 1. Hydrate pending reviews from DB
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

        // 2. Setup daily 8 PM summary
        this._setupDailyCron();

        // 3. Setup lead sweep — catches leads who never explicitly closed conversation
        this._setupLeadSweep();
    }

    /**
     * Check if this customer already got a review request recently (30-day cooldown).
     * Prevents spamming the same person multiple times.
     */
    async wasRecentlyRequested(tenantId, phone, withinDays = 30) {
        if (!db.isConnected()) return false;
        const result = await db.query(
            `SELECT id FROM review_requests
             WHERE tenant_id = $1 AND customer_phone = $2
               AND status IN ('pending','sent')
               AND created_at >= NOW() - INTERVAL '${withinDays} days'
             LIMIT 1`,
            [tenantId, phone]
        );
        return result && result.rows.length > 0;
    }

    /**
     * Schedule a new review request — with dedup guard.
     * @param {string} tenantId 
     * @param {string} customerName 
     * @param {string} customerPhone
     * @param {boolean} skipDedup  set true to force (e.g. manual #review command)
     */
    async scheduleReview(tenantId, customerName, customerPhone, skipDedup = false) {
        if (!db.isConnected()) {
            console.error('⚠️ Database not connected. Cannot persist review request.');
            return false;
        }

        // Dedup guard — skip if already requested in last 30 days
        if (!skipDedup) {
            const alreadySent = await this.wasRecentlyRequested(tenantId, customerPhone);
            if (alreadySent) {
                console.log(`⏭️  Review skipped for ${customerPhone} on ${tenantId} — sent within 30 days`);
                return false;
            }
        }

        try {
            const delayHours = parseInt(process.env.REVIEW_DELAY_HOURS) || 1;

            const result = await db.query(
                `INSERT INTO review_requests (tenant_id, customer_name, customer_phone, scheduled_for, status)
                 VALUES ($1, $2, $3, NOW() + INTERVAL '${delayHours} hour', 'pending') RETURNING *`,
                [tenantId, customerName, customerPhone]
            );

            if (result && result.rows[0]) {
                const row = result.rows[0];
                this._scheduleTimeout(row);
                console.log(`🗓️ Scheduled review request for ${customerName} (${customerPhone}) in ${delayHours} hour(s).`);
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Failed to schedule review:', error.message);
            return false;
        }
    }

    /**
     * Scheduled sweep — runs every day at 10 AM.
     * Finds leads who had a positive interaction (converted/active) but never
     * got a review request, and schedules one for them automatically.
     * This is the fallback for when the conversation never had an explicit closure.
     */
    _setupLeadSweep() {
        const now = new Date();
        const next = new Date();
        const sweepHour = parseInt(process.env.REVIEW_SWEEP_HOUR) || 10; // 10 AM default
        next.setHours(sweepHour, 0, 0, 0);
        if (now >= next) next.setDate(next.getDate() + 1);

        const delayMs = next - now;
        console.log(`🔍 Review lead sweep scheduled for ${next.toLocaleString()}`);

        setTimeout(async () => {
            await this._runLeadSweep();
            this._setupLeadSweep(); // reschedule for next day
        }, delayMs);
    }

    async _runLeadSweep() {
        if (!db.isConnected()) return;
        console.log('🔍 Running daily review lead sweep...');

        try {
            const tenants = tenantService.getAllTenants();
            for (const tenant of tenants) {
                if (!tenant.reviewLink) continue; // skip tenants without review link

                // Find customers who:
                // 1. Messaged in the last 7 days
                // 2. Have NOT received a review request yet
                // 3. Sent at least 3 messages (shows genuine engagement)
                const result = await db.query(`
                    SELECT c.phone, c.push_name, c.message_count
                    FROM customers c
                    WHERE c.tenant_id = $1
                      AND c.last_seen >= NOW() - INTERVAL '7 days'
                      AND c.message_count >= 3
                      AND NOT EXISTS (
                          SELECT 1 FROM review_requests r
                          WHERE r.tenant_id = c.tenant_id
                            AND r.customer_phone = c.phone
                            AND r.created_at >= NOW() - INTERVAL '30 days'
                      )
                    ORDER BY c.last_seen DESC
                    LIMIT 50
                `, [tenant.id]);

                if (!result || result.rows.length === 0) continue;

                console.log(`🔍 Sweep found ${result.rows.length} unreviewed customers for ${tenant.name}`);

                for (const customer of result.rows) {
                    await this.scheduleReview(
                        tenant.id,
                        customer.push_name || 'Customer',
                        customer.phone,
                        false // dedup still applies
                    );
                    // Small delay between scheduling to avoid DB hammering
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } catch (err) {
            console.error('❌ Review lead sweep failed:', err.message);
        }
    }

    /**
     * Set a javascript timeout for a review request row
     */
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

    /**
     * Actually send the WhatsApp message
     */
    async _sendReviewMessage(row) {
        try {
            const tenant = tenantService.getTenantById(row.tenant_id);
            if (!tenant || !tenant.reviewLink) {
                console.error(`⚠️ Missing tenant or reviewLink for ${row.tenant_id}`);
                return;
            }

            const message = `Hi ${row.customer_name}, thanks for visiting us!\n\nIf you had a great experience, please take a moment to leave us a 5-star review here: ${tenant.reviewLink}\n\nWe appreciate your support!`;

            // Clean number (ensure no spaces/plus)
            const targetNumber = row.customer_phone.replace(/\D/g, '');

            console.log(`📤 Sending delayed review request to ${targetNumber} for ${tenant.name}`);
            await evolutionService.sendText(tenant.instanceName, targetNumber, message);

            // Update DB
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

    /**
     * Set up a timer to trigger exactly at the next 8:00 PM
     */
    _setupDailyCron() {
        const now = new Date();
        let next8PM = new Date();
        next8PM.setHours(20, 0, 0, 0);

        // If it's already past 8 PM, schedule for tomorrow 8 PM
        if (now.getTime() >= next8PM.getTime()) {
            next8PM.setDate(next8PM.getDate() + 1);
        }

        const delayMs = next8PM.getTime() - now.getTime();
        console.log(`⏰ Daily review summary scheduled for ${next8PM.toLocaleString()}`);

        if (this.summaryTimer) clearTimeout(this.summaryTimer);

        this.summaryTimer = setTimeout(async () => {
            await this._sendDailySummaries();
            // Re-schedule for next day
            this._setupDailyCron();
        }, delayMs);
    }

    /**
     * Send summary to all shop owners
     */
    async _sendDailySummaries() {
        if (!db.isConnected()) return;

        console.log('📊 Generating daily review summaries...');
        try {
            // Count sent requests for today per tenant
            const result = await db.query(
                `SELECT tenant_id, COUNT(*) as count 
                 FROM review_requests 
                 WHERE status = 'sent' 
                 AND created_at >= CURRENT_DATE 
                 GROUP BY tenant_id`
            );

            const sentStats = {};
            if (result && result.rows) {
                result.rows.forEach(r => {
                    sentStats[r.tenant_id] = parseInt(r.count, 10);
                });
            }

            const tenants = tenantService.getAllTenants();
            for (const tenant of tenants) {
                const count = sentStats[tenant.id] || 0;
                if (!tenant.ownerPhone) continue;

                // Even if 0, maybe the owner wants to know, but let's send only if > 0 to avoid spam? 
                // The prompt says "owner gets a summary of how many review requests were sent that day." 
                // Sending even 0 keeps them aware the system is alive.
                const message = `📈 *Google Review Booster Summary*\n\nToday, ${count} review request(s) were successfully sent to your customers!`;

                await evolutionService.sendText(tenant.instanceName, tenant.ownerPhone.replace(/\D/g, ''), message);
                console.log(`📤 Sent daily summary to ${tenant.name} (${tenant.ownerPhone}): ${count} requests.`);
            }
        } catch (error) {
            console.error('❌ Failed to send daily summaries:', error.message);
        }
    }
}

module.exports = new ReviewService();