const tenantsConfig = require('../tenants.config');

class TenantService {
    constructor() {
        this.tenants = tenantsConfig;
    }

    /**
     * Get a tenant configuration by its internal ID
     * @param {string} tenantId
     * @returns {object|null}
     */
    getTenantById(tenantId) {
        // Search values to match the id field
        return Object.values(this.tenants).find(t => t.id === tenantId) || null;
    }

    /**
     * Resolve the tenant based on the Evolution Instance Name 
     * (used heavily by the webhook payload routing)
     * @param {string} instanceName
     * @returns {object|null}
     */
    getTenantByInstance(instanceName) {
        if (!instanceName) return null;

        // Match instance name ignoring case
        return Object.values(this.tenants).find(
            t => t.instanceName.toLowerCase() === instanceName.toLowerCase()
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
