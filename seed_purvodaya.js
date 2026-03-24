require('dotenv').config();
const db = require('./src/services/db.service');
const productService = require('./src/services/product.service');

async function seedProducts() {
    console.log('Connecting to database...');
    await db.connect();

    if (!db.isConnected()) {
        console.log('Database not connected, skipping seed.');
        process.exit(1);
    }

    const tenantId = 'purvodaya';

    const products = [
        {
            name: '1kW Solar System',
            price: '₹50,000 - ₹60,000',
            description: 'Ideal for small homes. Generates ~4-5 units/day. Subsidies available.'
        },
        {
            name: '2kW Solar System',
            price: '₹1,00,000 - ₹1,20,000',
            description: 'Ideal for medium homes with air conditioning. Generates ~8-10 units/day. Huge subsidies.'
        },
        {
            name: '3kW Solar System',
            price: '₹1,50,000 - ₹1,80,000',
            description: 'Perfect for large homes with multiple ACs. Generates ~12-15 units/day. Max subsidy of ₹78,000 available.'
        },
        {
            name: 'Commercial Solar Installation (10kW+)',
            price: 'Custom Quote',
            description: 'Lower your business operational costs. Contact us for a free site assessment and customized quote.'
        }
    ];

    console.log('\nSeeding Purvodaya Products...');
    for (const p of products) {
        // Just adding directly, might duplicate if run multiple times but it's for demo
        await productService.addProduct(tenantId, p.name, p.price, p.description);
    }

    const count = await productService.listProducts(tenantId);
    console.log(`\n✅ Seeding complete! Purvodaya now has ${count.length} products in the catalog.`);
    process.exit(0);
}

seedProducts();
