const tenantsConfig = require('../tenants.config');
const db = require('./db.service');

class TenantService {
    constructor() {
        // Fallback to config initially
        this.tenants = tenantsConfig;
    }

    /**
     * Load tenants from Database into memory.
     * Call this on server startup after DB connects.
     */
    async loadFromDb() {
        if (!db.isConnected()) return;
        try {


            // Now load all from DB into memory cache
            const result = await db.query('SELECT * FROM tenants WHERE is_active = true OR is_active IS NULL');
            if (result && result.rows.length > 0) {
                const dbTenants = {};
                for (const row of result.rows) {
                    dbTenants[row.id] = {
                        id: row.id,
                        name: row.name,
                        instanceName: row.instance_name,
                        systemPrompt: row.system_prompt,
                        ignoredNumbers: (row.ignored_numbers || '').split(',').map(s => s.trim()).filter(Boolean),
                        allowedGroups: (row.allowed_groups || '').split(',').map(s => s.trim()).filter(Boolean),
                        takeoverTimeoutMs: row.takeover_timeout_ms || 1800000,
                        upiId: row.upi_id,
                        upiName: row.upi_name,
                        reviewLink: row.review_link,
                        ownerPhone: row.owner_phone,
                        skipAI: row.skip_ai
                    };
                }
                this.tenants = dbTenants;
                console.log(`🏢 Loaded ${Object.keys(this.tenants).length} tenants from Database`);
            }
        } catch (error) {
            console.error('❌ Failed to load tenants from DB:', error.message);
        }
    }

    /**
     * Get a tenant configuration by its internal ID
     * @param {string} tenantId
     * @returns {object|null}
     */
    getTenantById(tenantId) {
        return Object.values(this.tenants).find(t => t.id === tenantId) || null;
    }

    /**
     * Resolve the tenant based on the Evolution Instance Name 
     * @param {string} instanceName
     * @returns {object|null}
     */
    getTenantByInstance(instanceName) {
        if (!instanceName) return null;
        return Object.values(this.tenants).find(
            t => t.instanceName.toLowerCase() === instanceName.toLowerCase()
        ) || null;
    }

    /**
     * Get a tenant configuration by its owner's phone number
     * @param {string} ownerPhone
     * @returns {object|null}
     */
    getTenantByOwnerPhone(ownerPhone) {
        if (!ownerPhone) return null;
        const cleanPhone = ownerPhone.replace(/\D/g, '');
        return Object.values(this.tenants).find(
            t => (t.ownerPhone || '').replace(/\D/g, '') === cleanPhone
        ) || null;
    }

    /**
     * Get all active tenants
     * @returns {Array} List of tenant config objects
     */
    getAllTenants() {
        return Object.values(this.tenants);
    }
}

module.exports = new TenantService();
