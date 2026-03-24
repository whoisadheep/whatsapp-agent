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
    }

    /**
     * Schedule a new review request
     * @param {string} tenantId 
     * @param {string} customerName 
     * @param {string} customerPhone 
     */
    async scheduleReview(tenantId, customerName, customerPhone) {
        if (!db.isConnected()) {
            console.error('⚠️ Database not connected. Cannot persist review request.');
            return false;
        }

        try {
            // Default delay is 1 hour
            // Using 1 hour delay (can be mocked for testing by modifying this)
            const delayHours = 1;
            
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
