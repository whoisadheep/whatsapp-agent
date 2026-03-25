const express = require('express');
const businessCoachService = require('../services/business_coach.service');
const tenantService = require('../services/tenant.service');

const router = express.Router();

/**
 * POST /api/coach/trigger
 * Manually trigger a briefing for a specific tenant (for testing or on-demand use).
 *
 * Body: { tenantId: "purvodaya", secret: "..." }
 */
router.post('/trigger', async (req, res) => {
    try {
        const { tenantId, secret } = req.body;

        // Simple secret guard — set COACH_API_SECRET in .env
        const expectedSecret = process.env.COACH_API_SECRET;
        if (expectedSecret && secret !== expectedSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!tenantId) {
            return res.status(400).json({ error: 'tenantId is required' });
        }

        const tenant = tenantService.getTenantById(tenantId);
        if (!tenant) {
            return res.status(404).json({ error: `Tenant "${tenantId}" not found` });
        }

        // Fire async — respond immediately so the caller doesn't timeout
        res.json({ status: 'queued', message: `Briefing generation started for ${tenant.name}` });

        // Run after response is sent
        setImmediate(async () => {
            await businessCoachService.triggerManual(tenantId);
        });

    } catch (error) {
        console.error('Coach trigger error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/coach/trigger-all
 * Trigger briefings for all tenants at once.
 */
router.post('/trigger-all', async (req, res) => {
    try {
        const { secret } = req.body;
        const expectedSecret = process.env.COACH_API_SECRET;
        if (expectedSecret && secret !== expectedSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        res.json({ status: 'queued', message: 'Briefings started for all tenants' });

        setImmediate(async () => {
            await businessCoachService.sendAllBriefings();
        });

    } catch (error) {
        console.error('Coach trigger-all error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/coach/history/:tenantId
 * Fetch past briefings for a tenant.
 *
 * Query params: ?limit=7
 */
router.get('/history/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 7, 30);

        const tenant = tenantService.getTenantById(tenantId);
        if (!tenant) {
            return res.status(404).json({ error: `Tenant "${tenantId}" not found` });
        }

        const history = await businessCoachService.getBriefingHistory(tenantId, limit);

        res.json({
            tenant: tenant.name,
            briefings: history.map(b => ({
                date: b.briefing_date,
                status: b.status,
                sentAt: b.sent_at,
                metrics: b.metrics,
                insights: b.insights,
            })),
        });

    } catch (error) {
        console.error('Coach history error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/coach/status
 * Quick health check — are briefings scheduled?
 */
router.get('/status', (req, res) => {
    const tenants = tenantService.getAllTenants();
    const hour = parseInt(process.env.COACH_BRIEFING_HOUR ?? 8);

    res.json({
        status: 'active',
        briefingHour: `${hour}:00 AM daily`,
        tenantsMonitored: tenants.map(t => ({
            id: t.id,
            name: t.name,
            ownerPhone: t.ownerPhone ? `...${t.ownerPhone.slice(-4)}` : 'NOT SET',
        })),
    });
});

module.exports = router;