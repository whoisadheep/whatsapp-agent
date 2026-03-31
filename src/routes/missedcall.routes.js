const express = require('express');
const evolutionService = require('../services/evolution.service');
const tenantService = require('../services/tenant.service');

const router = express.Router();

// ─── CONFIG ─────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.MISSED_CALL_SECRET || 'your_missed_call_secret_here';
const MISSED_CALL_TENANT_ID = process.env.MISSED_CALL_TENANT_ID || 'sai_infotek';

// Deduplication: Ignore duplicate webhooks for the same number within this window
const DEDUP_WINDOW_MS = 60_000;
const recentMissedCalls = new Map();

// ─── MISSED CALL WEBHOOK ENDPOINT ──────────────────────────────
router.post('/', async (req, res) => {
    try {
        // 1. Verify webhook secret
        const secret = req.headers['x-webhook-secret'];
        if (secret !== WEBHOOK_SECRET) {
            console.warn('🚫 Missed call webhook: invalid secret');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { phone, timestamp, event, tenant_id } = req.body;

        // 2. Validate payload
        if (!phone || event !== 'missed_call') {
            console.warn('⚠️ Missed call webhook: invalid payload', req.body);
            return res.status(400).json({ error: 'Invalid payload' });
        }

        // 3. Normalize phone number (ensure 91XXXXXXXXXX format)
        let normalizedPhone = phone.replace(/[^0-9]/g, '');
        if (normalizedPhone.length === 10) {
            normalizedPhone = '91' + normalizedPhone;
        }

        // 4. Resolve tenant — app can send tenant_id, otherwise use env default
        const targetTenantId = tenant_id || MISSED_CALL_TENANT_ID;
        const tenants = tenantService.getAllTenants();
        const tenant = tenants.find(t => t.id === targetTenantId);

        if (!tenant) {
            console.error(`❌ Tenant "${targetTenantId}" not found`);
            return res.status(400).json({ error: `Tenant "${targetTenantId}" not found. Valid: ${tenants.map(t => t.id).join(', ')}` });
        }

        console.log(`\n📞 MISSED CALL from: ${normalizedPhone} → ${tenant.name} at ${new Date(timestamp).toLocaleString()}`);

        // 5. Deduplication check (per-tenant so same number can trigger on different tenants)
        const dedupKey = `${targetTenantId}:${normalizedPhone}`;
        const lastSeen = recentMissedCalls.get(dedupKey);
        if (lastSeen && Date.now() - lastSeen < DEDUP_WINDOW_MS) {
            console.log(`⏭️ Duplicate missed call from ${normalizedPhone} on ${tenant.name}, skipping`);
            return res.status(200).json({ status: 'duplicate', phone: normalizedPhone });
        }
        recentMissedCalls.set(dedupKey, Date.now());

        // Cleanup old entries
        for (const [key, time] of recentMissedCalls) {
            if (Date.now() - time > DEDUP_WINDOW_MS) recentMissedCalls.delete(key);
        }

        // 6. Compose and send the WhatsApp message
        const missedCallMessage = generateMissedCallMessage(tenant.name);

        await evolutionService.sendText(
            tenant.instanceName,
            normalizedPhone,
            missedCallMessage
        );

        console.log(`✅ WhatsApp reply sent to ${normalizedPhone} via ${tenant.instanceName}`);

        // 7. Notify the owner about the missed call
        if (tenant.ownerPhone) {
            const ownerAlert =
                `📞 *Missed Call Alert*\n\n` +
                `📱 From: ${normalizedPhone}\n` +
                `🕐 Time: ${new Date(timestamp).toLocaleString('en-IN')}\n\n` +
                `_AI ne auto-reply bhej diya hai._`;
            evolutionService.sendText(
                tenant.instanceName,
                tenant.ownerPhone.replace(/\D/g, ''),
                ownerAlert
            ).catch(() => {});
        }

        return res.status(200).json({
            status: 'sent',
            phone: normalizedPhone,
            tenant: tenant.id
        });

    } catch (error) {
        console.error('❌ Missed call webhook error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Generate the auto-reply message for missed calls.
 * Customize the text per tenant as needed.
 */
function generateMissedCallMessage(businessName) {
    return (
        `Namaste! 🙏\n\n` +
        `Aapka call aaya tha *${businessName}* par, lekin hum attend nahi kar paye.\n\n` +
        `Kripya apna message yahan WhatsApp par bhejein — hum jaldi se jaldi reply karenge!\n\n` +
        `_Yeh ek automatic message hai._`
    );
}

module.exports = router;
