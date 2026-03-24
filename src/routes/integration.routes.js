const express = require('express');
const tenantService = require('../services/tenant.service');
const evolutionService = require('../services/evolution.service');
const conversationService = require('../services/conversation.service');

const router = express.Router();

/**
 * POST /api/integration/missed-call
 * Endpoint hit by the Flutter app when a missed call is detected
 */
router.post('/missed-call', async (req, res) => {
    try {
        const { ownerPhone, callerPhone, timestamp } = req.body;

        if (!ownerPhone || !callerPhone) {
            return res.status(400).json({ error: 'ownerPhone and callerPhone are required' });
        }

        // Clean phone numbers
        const cleanCallerPhone = callerPhone.replace(/\D/g, '');
        
        // 1. Find the tenant by owner phone
        const tenant = tenantService.getTenantByOwnerPhone(ownerPhone);
        
        if (!tenant) {
            console.log(`⚠️ Missed call integration: Unknown owner phone ${ownerPhone}`);
            return res.status(404).json({ error: 'Tenant not found for the given owner phone' });
        }

        console.log(`📞 Missed call detected for ${tenant.name} from ${cleanCallerPhone}`);

        // 2. Generate the proactive message
        const proactiveMessage = `Hi! I'm the AI assistant for *${tenant.name}*. We just missed a call from this number.\n\nHow can I help you today?`;

        // Wait a few seconds to simulate a natural delay before the AI replies
        setTimeout(async () => {
            try {
                // 3. Send message to caller
                await evolutionService.sendText(tenant.instanceName, cleanCallerPhone, proactiveMessage);
                
                // 4. Save to conversation history to give AI context
                // We add the user's intent as a system/hidden context or as an assistant message
                await conversationService.addMessage(
                    tenant.id, 
                    cleanCallerPhone, 
                    'user', 
                    '[SYSTEM NOTE: The business owner missed a call from this customer. The AI is now proactively messaging them.]'
                );
                await conversationService.addMessage(
                    tenant.id, 
                    cleanCallerPhone, 
                    'assistant', 
                    proactiveMessage
                );
                
                console.log(`✅ Sent missed call proactive message to ${cleanCallerPhone} for ${tenant.name}`);
            } catch (err) {
                console.error(`❌ Failed to send proactive missed call message: ${err.message}`);
            }
        }, 3000); // 3-second delay

        return res.status(200).json({ status: 'success', message: 'Missed call event received and processing' });

    } catch (error) {
        console.error('❌ Integration webhook error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
