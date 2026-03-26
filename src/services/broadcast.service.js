const db = require('./db.service');
const evolutionService = require('./evolution.service');

// Delay between each message to avoid WhatsApp spam detection (ms)
const SEND_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS) || 1500;

// Max recipients per broadcast (safety cap)
const MAX_RECIPIENTS = parseInt(process.env.BROADCAST_MAX_RECIPIENTS) || 500;

class BroadcastService {
    constructor() {
        // Track active broadcasts per tenant: Map<tenantId, { jobId, cancelled, stats }>
        this.activeJobs = new Map();
    }

    // ═══════════════════════════════════════════════════════════════
    //  DB SETUP
    // ═══════════════════════════════════════════════════════════════

    async ensureTables() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS broadcast_jobs (
                id           SERIAL PRIMARY KEY,
                tenant_id    VARCHAR(50)  NOT NULL,
                message      TEXT         NOT NULL,
                audience     VARCHAR(20)  NOT NULL DEFAULT 'all',
                total        INTEGER      DEFAULT 0,
                sent         INTEGER      DEFAULT 0,
                failed       INTEGER      DEFAULT 0,
                skipped      INTEGER      DEFAULT 0,
                status       VARCHAR(20)  DEFAULT 'pending',
                started_at   TIMESTAMP,
                completed_at TIMESTAMP,
                created_at   TIMESTAMP    DEFAULT NOW()
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS broadcast_optouts (
                tenant_id  VARCHAR(50) NOT NULL,
                phone      VARCHAR(20) NOT NULL,
                created_at TIMESTAMP   DEFAULT NOW(),
                PRIMARY KEY (tenant_id, phone)
            )
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_tenant
            ON broadcast_jobs(tenant_id, created_at DESC)
        `);

        console.log('✅ Broadcast tables ready');
    }

    // ═══════════════════════════════════════════════════════════════
    //  OPT-OUT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    async optOut(tenantId, phone) {
        if (!db.isConnected()) return false;
        await db.query(`
            INSERT INTO broadcast_optouts (tenant_id, phone)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        `, [tenantId, phone]);
        console.log(`🚫 ${phone} opted out of broadcasts for ${tenantId}`);
        return true;
    }

    async isOptedOut(tenantId, phone) {
        if (!db.isConnected()) return false;
        const result = await db.query(
            'SELECT 1 FROM broadcast_optouts WHERE tenant_id = $1 AND phone = $2',
            [tenantId, phone]
        );
        return result && result.rows.length > 0;
    }

    async getOptOutCount(tenantId) {
        if (!db.isConnected()) return 0;
        const result = await db.query(
            'SELECT COUNT(*) as count FROM broadcast_optouts WHERE tenant_id = $1',
            [tenantId]
        );
        return parseInt(result?.rows[0]?.count) || 0;
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUDIENCE RESOLUTION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get list of recipients based on audience type.
     * audience: 'all' | 'leads' | 'customers' | 'new_leads'
     */
    async getRecipients(tenantId, audience) {
        if (!db.isConnected()) return [];

        let query, params;

        switch (audience) {
            case 'leads':
                // All leads (regardless of status)
                query = `
                    SELECT DISTINCT ON (phone) phone, name as push_name
                    FROM leads
                    WHERE tenant_id = $1
                    ORDER BY phone, created_at DESC
                `;
                params = [tenantId];
                break;

            case 'new_leads':
                // Only leads not yet converted
                query = `
                    SELECT DISTINCT ON (phone) phone, name as push_name
                    FROM leads
                    WHERE tenant_id = $1 AND status = 'new'
                    ORDER BY phone, created_at DESC
                `;
                params = [tenantId];
                break;

            case 'customers':
                // All customers who have messaged before
                query = `
                    SELECT phone, push_name
                    FROM customers
                    WHERE tenant_id = $1
                    ORDER BY last_seen DESC
                `;
                params = [tenantId];
                break;

            case 'all':
            default:
                // Union of customers + leads (deduplicated by phone)
                query = `
                    SELECT phone, push_name FROM customers WHERE tenant_id = $1
                    UNION
                    SELECT phone, name as push_name FROM leads WHERE tenant_id = $1
                `;
                params = [tenantId];
                break;
        }

        const result = await db.query(query, params);
        if (!result) return [];

        // Filter out opted-out numbers
        const optOutResult = await db.query(
            'SELECT phone FROM broadcast_optouts WHERE tenant_id = $1',
            [tenantId]
        );
        const optedOut = new Set((optOutResult?.rows || []).map(r => r.phone));

        return result.rows
            .filter(r => !optedOut.has(r.phone))
            .slice(0, MAX_RECIPIENTS);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PREVIEW (dry run)
    // ═══════════════════════════════════════════════════════════════

    async preview(tenantId, audience, message) {
        const recipients = await this.getRecipients(tenantId, audience);
        const optOutCount = await this.getOptOutCount(tenantId);

        return {
            recipientCount: recipients.count || recipients.length,
            optOutCount,
            audience,
            messageSample: message.slice(0, 100) + (message.length > 100 ? '...' : ''),
            estimatedTimeMin: Math.ceil((recipients.length * SEND_DELAY_MS) / 60000),
            sampleRecipients: recipients.slice(0, 3).map(r => ({
                name: r.push_name || 'Customer',
                phone: `...${r.phone.slice(-4)}`,
            })),
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  SEND BROADCAST (async, runs in background)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Start a broadcast job. Returns immediately — runs in background.
     * @param {object} tenant
     * @param {string} audience  - 'all' | 'leads' | 'new_leads' | 'customers'
     * @param {string} message
     * @param {string} ownerPhone - where to send progress updates
     * @returns {number} jobId
     */
    async start(tenant, audience, message, ownerPhone) {
        if (!db.isConnected()) throw new Error('Database not connected');

        // Only one active broadcast per tenant at a time
        if (this.activeJobs.has(tenant.id)) {
            throw new Error('A broadcast is already in progress. Send #broadcast stop to cancel it.');
        }

        const recipients = await this.getRecipients(tenant.id, audience);

        if (recipients.length === 0) {
            throw new Error(`No recipients found for audience "${audience}". Send some messages first to build your contact list.`);
        }

        // Create DB job record
        const jobResult = await db.query(`
            INSERT INTO broadcast_jobs (tenant_id, message, audience, total, status, started_at)
            VALUES ($1, $2, $3, $4, 'running', NOW())
            RETURNING id
        `, [tenant.id, message, audience, recipients.length]);

        const jobId = jobResult.rows[0].id;

        // Register active job
        const jobState = { jobId, cancelled: false, stats: { sent: 0, failed: 0, skipped: 0 } };
        this.activeJobs.set(tenant.id, jobState);

        console.log(`📢 Broadcast #${jobId} started for ${tenant.name}: ${recipients.length} recipients (${audience})`);

        // Kick off async — don't await
        this._runBroadcast(tenant, jobId, jobState, recipients, message, ownerPhone).catch(err => {
            console.error(`❌ Broadcast #${jobId} crashed:`, err.message);
            this.activeJobs.delete(tenant.id);
        });

        return { jobId, total: recipients.length };
    }

    async _runBroadcast(tenant, jobId, jobState, recipients, message, ownerPhone) {
        const { stats } = jobState;
        const total = recipients.length;
        let lastProgressUpdate = 0;

        for (let i = 0; i < total; i++) {
            // Check cancellation
            if (jobState.cancelled) {
                console.log(`🛑 Broadcast #${jobId} cancelled at ${i}/${total}`);
                await this._finishJob(jobId, tenant.id, 'cancelled', stats);
                await evolutionService.sendText(tenant.instanceName, ownerPhone,
                    `🛑 *Broadcast cancelled*\n\nSent: ${stats.sent} | Failed: ${stats.failed} | Cancelled at: ${i}/${total}`
                );
                this.activeJobs.delete(tenant.id);
                return;
            }

            const recipient = recipients[i];
            const phone = recipient.phone.replace(/\D/g, '');

            try {
                // Personalise message — replace {name} placeholder if present
                const personalised = message.replace(/\{name\}/gi, recipient.push_name || 'Customer');
                await evolutionService.sendText(tenant.instanceName, phone, personalised);
                stats.sent++;
            } catch (err) {
                console.error(`❌ Broadcast failed for ${phone}:`, err.message);
                stats.failed++;
            }

            // Progress update to owner every 25 sends or at 50% / 100%
            const progressPct = Math.round(((i + 1) / total) * 100);
            const shouldUpdate = (
                stats.sent % 25 === 0 ||
                progressPct === 50 ||
                i === total - 1
            ) && i !== lastProgressUpdate;

            if (shouldUpdate) {
                lastProgressUpdate = i;
                await evolutionService.sendText(tenant.instanceName, ownerPhone,
                    `📢 *Broadcast update* — Job #${jobId}\n\n` +
                    `Progress: ${i + 1}/${total} (${progressPct}%)\n` +
                    `✅ Sent: ${stats.sent} | ❌ Failed: ${stats.failed}`
                ).catch(() => { });
            }

            // Rate-limit delay between sends
            if (i < total - 1) {
                await new Promise(r => setTimeout(r, SEND_DELAY_MS));
            }
        }

        // Done
        await this._finishJob(jobId, tenant.id, 'completed', stats);
        this.activeJobs.delete(tenant.id);

        const summary =
            `✅ *Broadcast complete!* — Job #${jobId}\n\n` +
            `📊 *Results:*\n` +
            `• Audience: ${recipients.length} contacts\n` +
            `• Successfully sent: ${stats.sent}\n` +
            `• Failed: ${stats.failed}\n\n` +
            `_Note: Customers can reply STOP to opt out of future broadcasts._`;

        await evolutionService.sendText(tenant.instanceName, ownerPhone, summary);
        console.log(`✅ Broadcast #${jobId} complete for ${tenant.name}: ${stats.sent} sent, ${stats.failed} failed`);
    }

    async _finishJob(jobId, tenantId, status, stats) {
        if (!db.isConnected()) return;
        await db.query(`
            UPDATE broadcast_jobs
            SET status = $1, sent = $2, failed = $3, skipped = $4, completed_at = NOW()
            WHERE id = $5 AND tenant_id = $6
        `, [status, stats.sent, stats.failed, stats.skipped, jobId, tenantId]);
    }

    // ═══════════════════════════════════════════════════════════════
    //  CANCEL
    // ═══════════════════════════════════════════════════════════════

    cancel(tenantId) {
        const job = this.activeJobs.get(tenantId);
        if (!job) return false;
        job.cancelled = true;
        return true;
    }

    isRunning(tenantId) {
        return this.activeJobs.has(tenantId);
    }

    getActiveJob(tenantId) {
        return this.activeJobs.get(tenantId) || null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  HISTORY
    // ═══════════════════════════════════════════════════════════════

    async getHistory(tenantId, limit = 10) {
        if (!db.isConnected()) return [];
        const result = await db.query(`
            SELECT id, audience, total, sent, failed, status, started_at, completed_at,
                   LEFT(message, 80) as message_preview
            FROM broadcast_jobs
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [tenantId, limit]);
        return result?.rows || [];
    }
}

module.exports = new BroadcastService();