const db = require('./db.service');

class LeadService {
    /**
     * Capture or update a lead.
     * If the phone already exists for this tenant, update the interest and timestamp.
     */
    async captureLead(tenantId, phone, name, interest) {
        if (!db.isConnected()) return null;

        // Check if lead already exists
        const existing = await db.query(
            'SELECT * FROM leads WHERE tenant_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT 1',
            [tenantId, phone]
        );

        if (existing && existing.rows.length > 0) {
            // Update interest if new info is captured
            if (interest && interest !== existing.rows[0].interest) {
                await db.query(
                    `UPDATE leads SET interest = $1, name = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4`,
                    [interest, name, existing.rows[0].id, tenantId]
                );
                console.log(`📋 Lead updated for ${tenantId}: ${name} (${phone}) — Interest: ${interest}`);
            }
            return existing.rows[0];
        }

        // Create new lead
        const result = await db.query(
            'INSERT INTO leads (tenant_id, phone, name, interest) VALUES ($1, $2, $3, $4) RETURNING *',
            [tenantId, phone, name, interest || 'General inquiry']
        );

        if (result && result.rows[0]) {
            console.log(`🎯 New lead captured for ${tenantId}: ${name} (${phone}) — Interest: ${interest || 'General inquiry'}`);
            return result.rows[0];
        }
        return null;
    }

    /**
     * Extract interest/intent from a message using simple keyword matching.
     * This avoids extra API calls — fast and free.
     */
    extractInterest(messageText) {
        const text = messageText.toLowerCase();

        // Common interest patterns
        const patterns = [
            // Solar-specific patterns for Purvodaya
            { keywords: ['solar', 'panel', 'kw', 'kilo watt', 'kilowatt'], interest: 'Solar Panel Inquiry' },
            { keywords: ['subsidy', 'pm surya', 'yojana', 'government', 'discount on solar'], interest: 'Solar Subsidy Inquiry' },
            { keywords: ['visit', 'assessment', 'address', 'location', 'site marking'], interest: 'Site Assessment Request' },
            { keywords: ['bill', 'electricity bill', 'light bill', 'bill amount'], interest: 'Bill/Sizing Assessment' },

            // General business patterns
            { keywords: ['price', 'cost', 'rate', 'kitna', 'kitne', 'kya rate', 'how much'], interest: 'Pricing inquiry' },
            { keywords: ['order', 'buy', 'purchase', 'kharidna', 'lena hai', 'chahiye', 'want to buy'], interest: 'Purchase intent' },
            { keywords: ['delivery', 'shipping', 'deliver', 'bhej', 'send'], interest: 'Delivery inquiry' },
            { keywords: ['available', 'stock', 'hai kya', 'milega', 'in stock'], interest: 'Availability check' },
            { keywords: ['appointment', 'book', 'schedule', 'booking', 'slot'], interest: 'Appointment booking' },
            { keywords: ['complaint', 'problem', 'issue', 'broken', 'not working', 'kharab'], interest: 'Complaint/Support' },
            { keywords: ['return', 'refund', 'exchange', 'replace', 'wapas'], interest: 'Return/Refund' },
            { keywords: ['discount', 'offer', 'deal', 'coupon', 'sale'], interest: 'Looking for deals' },
            { keywords: ['hello', 'hi', 'hey', 'hii', 'hlo', 'namaste'], interest: 'General inquiry' },
        ];

        for (const pattern of patterns) {
            if (pattern.keywords.some(kw => text.includes(kw))) {
                return pattern.interest;
            }
        }

        return 'General inquiry';
    }

    /**
     * Get recent leads.
     */
    async getRecentLeads(tenantId, limit = 20) {
        if (!db.isConnected()) return [];

        const result = await db.query(
            'SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
            [tenantId, limit]
        );
        return result ? result.rows : [];
    }

    /**
     * Get lead count by status.
     */
    async getLeadStats(tenantId) {
        if (!db.isConnected()) return {};

        const result = await db.query(
            `SELECT status, COUNT(*) as count FROM leads WHERE tenant_id = $1 GROUP BY status`,
            [tenantId]
        );
        if (!result) return {};

        const stats = {};
        result.rows.forEach(r => { stats[r.status] = parseInt(r.count); });
        return stats;
    }

    /**
     * Get total lead count.
     */
    async getTotalCount(tenantId) {
        if (!db.isConnected()) return 0;
        const result = await db.query('SELECT COUNT(*) as count FROM leads WHERE tenant_id = $1', [tenantId]);
        return result ? parseInt(result.rows[0].count) : 0;
    }
}

module.exports = new LeadService();
