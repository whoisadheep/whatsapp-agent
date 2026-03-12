const db = require('./db.service');

class ProductService {
    constructor() {
        // In-memory cache for fast access (Map<tenantId, Array>)
        this.tenantProducts = new Map();
        this.cacheLoaded = new Map();
    }

    async loadCache(tenantId) {
        if (!db.isConnected()) return;
        const result = await db.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
        if (result) {
            this.tenantProducts.set(tenantId, result.rows);
            this.cacheLoaded.set(tenantId, true);
        }
    }

    /**
     * Add a product.
     * @param {string} tenantId
     * @param {string} name
     * @param {string} price
     * @param {string} description
     * @returns {object|null}
     */
    async addProduct(tenantId, name, price = '', description = '') {
        const result = await db.query(
            'INSERT INTO products (tenant_id, name, price, description) VALUES ($1, $2, $3, $4) RETURNING *',
            [tenantId, name.trim(), price.trim(), description.trim()]
        );
        if (result && result.rows[0]) {
            if (!this.tenantProducts.has(tenantId)) this.tenantProducts.set(tenantId, []);
            this.tenantProducts.get(tenantId).push(result.rows[0]);
            console.log(`📦 Product added for ${tenantId}: ${name} | ${price}`);
            return result.rows[0];
        }
        return null;
    }

    /**
     * Remove a product by name (case-insensitive).
     * @param {string} tenantId
     * @param {string} name
     * @returns {boolean}
     */
    async removeProduct(tenantId, name) {
        const result = await db.query(
            'DELETE FROM products WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) RETURNING *',
            [tenantId, name.trim()]
        );
        if (result && result.rowCount > 0) {
            if (this.tenantProducts.has(tenantId)) {
                this.tenantProducts.set(
                    tenantId,
                    this.tenantProducts.get(tenantId).filter(p => p.name.toLowerCase() !== name.trim().toLowerCase())
                );
            }
            console.log(`🗑️  Product removed for ${tenantId}: ${name}`);
            return true;
        }
        return false;
    }

    /**
     * Get all products for a tenant.
     * @param {string} tenantId
     * @returns {Array}
     */
    async listProducts(tenantId) {
        if (!this.cacheLoaded.get(tenantId)) await this.loadCache(tenantId);
        return this.tenantProducts.get(tenantId) || [];
    }

    /**
     * Get a formatted product catalog string for the AI prompt.
     * @param {string} tenantId
     * @returns {string}
     */
    async getCatalogText(tenantId) {
        const products = await this.listProducts(tenantId);
        if (products.length === 0) return '';

        let text = '\n\n--- PRODUCT CATALOG ---\n';
        text += 'Here are the products/services available. Use this to answer customer queries:\n\n';
        products.forEach((p, i) => {
            text += `${i + 1}. ${p.name}`;
            if (p.price) text += ` — ${p.price}`;
            if (p.description) text += ` — ${p.description}`;
            text += '\n';
        });
        text += '\n--- END CATALOG ---';
        return text;
    }

    /**
     * Get product count for a tenant.
     * @param {string} tenantId
     * @returns {number}
     */
    getCount(tenantId) {
        const products = this.tenantProducts.get(tenantId);
        return products ? products.length : 0;
    }
}

module.exports = new ProductService();
