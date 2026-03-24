const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const webhookRoutes = require('./routes/webhook.routes');
const healthRoutes = require('./routes/health.routes');
const evolutionService = require('./services/evolution.service');
const db = require('./services/db.service');
const takeoverService = require('./services/takeover.service');
const productService = require('./services/product.service');
const tenantService = require('./services/tenant.service');
const reviewService = require('./services/review.service');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('dev'));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/health', healthRoutes);
app.use('/api/integration', require('./routes/integration.routes'));

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp AI Agent',
        version: '2.0.0',
        endpoints: {
            webhook: 'POST /webhook',
            health: 'GET /health',
        },
    });
});

// Initialize all tenants and their Evolution API connections on startup
async function initializeTenants() {
    console.log('\n🔄 Initializing Database...');
    await db.connect();

    // Load globally persisted state from DB (Takeovers)
    if (db.isConnected()) {
        await takeoverService.loadFromDb();
        await reviewService.init();
    }

    const tenants = tenantService.getAllTenants();
    console.log(`\n🔄 Found ${tenants.length} tenants configuring...`);

    const port = process.env.PORT || 3001;
    const isDocker = process.env.DOCKER_ENV === 'true';
    const webhookHost = isDocker ? 'whatsapp-agent' : 'localhost';
    const webhookUrl = `http://${webhookHost}:${port}/webhook`;

    // Wait a few seconds for Evolution API to be ready
    await new Promise((resolve) => setTimeout(resolve, 5000));

    for (const tenant of tenants) {
        console.log(`\n--- Initializing Tenant: ${tenant.name} ---`);

        // Load products for this specific tenant
        if (db.isConnected()) {
            await productService.loadCache(tenant.id);
            console.log(`📦 Loaded ${productService.getCount(tenant.id)} products for ${tenant.name}`);
        }

        try {
            // Create Evolution instance
            await evolutionService.createInstance(tenant.instanceName);

            // Set webhook
            await evolutionService.setWebhook(tenant.instanceName, webhookUrl);

            // Check connection status
            const status = await evolutionService.getInstanceStatus(tenant.instanceName);
            console.log(`📱 Instance status (${tenant.instanceName}): ${JSON.stringify(status?.instance?.state || 'unknown')}`);

            if (status?.instance?.state !== 'open') {
                console.log(`\n📷 WhatsApp is not connected yet for ${tenant.name}.`);
                console.log(`   👉 Open http://localhost:3000 to scan the QR code for instance "${tenant.instanceName}"`);
            } else {
                console.log(`✅ WhatsApp is connected and ready for ${tenant.name}!`);
            }
        } catch (error) {
            console.error(`⚠️  Evolution API initialization failed for ${tenant.instanceName}:`, error.message);
            console.log('   The agent will still receive webhooks once Evolution API is ready.');
        }
    }
}

module.exports = { app, initializeTenants };
