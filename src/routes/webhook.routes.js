const express = require('express');
const evolutionService = require('../services/evolution.service');
const aiService = require('../services/ai.service');
const conversationService = require('../services/conversation.service');
const takeoverService = require('../services/takeover.service');
const productService = require('../services/product.service');
const leadService = require('../services/lead.service');
const tenantService = require('../services/tenant.service');

const router = express.Router();

// Track server start time to ignore old messages replayed on reconnect
const SERVER_START_TIME = Math.floor(Date.now() / 1000);
console.log(`🕐 Server start timestamp: ${SERVER_START_TIME} — messages before this will be ignored`);

// Process incoming webhook events from Evolution API
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const event = body.event;

        // Handle connection updates
        if (event === 'connection.update') {
            const state = body.data?.state;
            console.log(`📱 Connection update: ${state}`);

            if (state === 'open') {
                console.log('✅ WhatsApp connected successfully!');
            }

            return res.status(200).json({ status: 'ok' });
        }

        // Handle QR code updates
        if (event === 'qrcode.updated') {
            console.log('📷 QR Code updated — scan it in Evolution Manager at http://localhost:3000');
            return res.status(200).json({ status: 'ok' });
        }

        // Only process new incoming messages
        if (event !== 'messages.upsert') {
            return res.status(200).json({ status: 'ignored', reason: `event: ${event}` });
        }

        const data = body.data;

        // ─── SKIP OLD MESSAGES: Ignore messages from before server started ───
        const messageTimestamp = data.messageTimestamp || data.key?.messageTimestamp || 0;
        if (messageTimestamp && messageTimestamp < SERVER_START_TIME) {
            return res.status(200).json({ status: 'ignored', reason: 'old message (before server start)' });
        }

        // ─── IDENTIFY TENANT ───
        const instanceName = body.instance || body.instanceName;
        const tenant = tenantService.getTenantByInstance(instanceName);

        if (!tenant) {
            console.log(`⚠️  Webhook received for unknown instance: ${instanceName}, ignoring`);
            return res.status(200).json({ status: 'ignored', reason: 'unknown tenant' });
        }

        const remoteJid = data.key?.remoteJid || '';
        const senderNumber = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');

        // ─── OWNER COMMANDS: Detect owner's manual replies ───
        if (data.key?.fromMe) {
            const messageText =
                data.message?.conversation ||
                data.message?.extendedTextMessage?.text || '';

            const command = messageText.trim().toLowerCase();

            // ─── AI CONTROL COMMANDS ───
            if (command === '#ai on') {
                takeoverService.resume(tenant.id, senderNumber);
                console.log(`▶️  Owner resumed AI for ${senderNumber} on ${tenant.name}`);
                return res.status(200).json({ status: 'ai_resumed', contact: senderNumber });
            }

            if (command === '#ai off') {
                takeoverService.pause(tenant, senderNumber, null);
                console.log(`🛑 Owner paused AI indefinitely for ${senderNumber} on ${tenant.name}`);
                return res.status(200).json({ status: 'ai_paused_indefinitely', contact: senderNumber });
            }

            if (command === '#ai status') {
                const status = takeoverService.isPaused(tenant.id, senderNumber)
                    ? `Paused (${takeoverService.getRemainingTime(tenant.id, senderNumber)})`
                    : 'Active';
                console.log(`ℹ️  AI status for ${senderNumber} on ${tenant.name}: ${status}`);
                return res.status(200).json({ status: 'ai_status', contact: senderNumber, aiStatus: status });
            }

            // ─── PRODUCT COMMANDS ───
            if (messageText.trim().toLowerCase().startsWith('#add ')) {
                const parts = messageText.trim().substring(5).split('|').map(s => s.trim());
                const name = parts[0] || '';
                const price = parts[1] || '';
                const description = parts[2] || '';

                if (!name) {
                    console.log('⚠️  #add command missing product name');
                    return res.status(200).json({ status: 'error', reason: 'missing product name' });
                }

                const product = await productService.addProduct(tenant.id, name, price, description);
                if (product) {
                    // Send confirmation back to the owner in the chat
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `✅ Product added!\n\n📦 *${name}*\n💰 ${price || 'No price set'}\n📝 ${description || 'No description'}\n\nTotal products: ${productService.getCount(tenant.id)}`
                    );
                }
                return res.status(200).json({ status: 'product_added', product: name });
            }

            if (messageText.trim().toLowerCase().startsWith('#remove ')) {
                const name = messageText.trim().substring(8).trim();
                const removed = await productService.removeProduct(tenant.id, name);
                if (removed) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `🗑️ Product removed: *${name}*\n\nTotal products: ${productService.getCount(tenant.id)}`
                    );
                } else {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `⚠️ Product not found: "${name}"`
                    );
                }
                return res.status(200).json({ status: 'product_removed', product: name });
            }

            if (command === '#list') {
                const products = await productService.listProducts(tenant.id);
                if (products.length === 0) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        '📦 No products in catalog yet.\n\nAdd with: #add Product Name | Price | Description'
                    );
                } else {
                    let list = `📦 *Product Catalog* (${products.length} items)\n\n`;
                    products.forEach((p, i) => {
                        list += `${i + 1}. *${p.name}*`;
                        if (p.price) list += ` — ${p.price}`;
                        if (p.description) list += `\n   ${p.description}`;
                        list += '\n';
                    });
                    list += '\n_Commands: #add, #remove, #list_';
                    await evolutionService.sendText(tenant.instanceName, senderNumber, list);
                }
                return res.status(200).json({ status: 'product_list' });
            }

            // ─── LEAD COMMANDS ───
            if (command === '#leads') {
                const leads = await leadService.getRecentLeads(tenant.id, 10);
                if (leads.length === 0) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        '📋 No leads captured yet.\n\nLeads are automatically captured when customers message you.'
                    );
                } else {
                    const totalCount = await leadService.getTotalCount(tenant.id);
                    let list = `🎯 *Recent Leads* (showing ${leads.length} of ${totalCount})\n\n`;
                    leads.forEach((l, i) => {
                        const date = new Date(l.created_at).toLocaleDateString('en-IN', {
                            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                        });
                        list += `${i + 1}. *${l.name}*\n   📞 ${l.phone}\n   💡 ${l.interest || 'General'}\n   🕐 ${date}\n\n`;
                    });
                    await evolutionService.sendText(tenant.instanceName, senderNumber, list);
                }
                return res.status(200).json({ status: 'leads_list' });
            }

            // Any other manual reply from owner → auto-pause AI for this contact
            if (!command.startsWith('#')) {
                takeoverService.pause(tenant, senderNumber);
                console.log(`🤝 Owner replied manually to ${senderNumber} on ${tenant.name} — AI paused automatically`);
            }

            return res.status(200).json({ status: 'ignored', reason: 'fromMe' });
        }

        // Handle group messages selectively
        if (remoteJid.endsWith('@g.us')) {
            const allowedGroups = tenant.allowedGroups || [];

            if (!allowedGroups.includes('*') && !allowedGroups.includes(remoteJid)) {
                console.log(`⏭️  Message from group ${remoteJid} on ${tenant.name}, skipping.`);
                return res.status(200).json({ status: 'ignored', reason: 'group not in allowedGroups' });
            }
            console.log(`✅ Message from allowed group on ${tenant.name}: ${remoteJid}`);
        }

        // Ignore status broadcasts
        if (remoteJid === 'status@broadcast') {
            return res.status(200).json({ status: 'ignored', reason: 'status broadcast' });
        }

        // Extract message text
        const messageText =
            data.message?.conversation ||
            data.message?.extendedTextMessage?.text ||
            data.message?.imageMessage?.caption ||
            data.message?.videoMessage?.caption ||
            null;

        if (!messageText) {
            console.log('⏭️  Non-text message received, skipping');
            return res.status(200).json({ status: 'ignored', reason: 'non-text message' });
        }

        const pushName = data.pushName || 'Customer';

        // Ignore messages from explicitly ignored numbers for this tenant
        const ignoredNumbers = tenant.ignoredNumbers || [];
        if (ignoredNumbers.includes(senderNumber)) {
            console.log(`⏭️  Message from ignored number ${senderNumber} on ${tenant.name}, skipping`);
            return res.status(200).json({ status: 'ignored', reason: 'ignored number' });
        }

        // ─── HUMAN TAKEOVER: Skip AI if owner has taken over this chat ───
        if (takeoverService.isPaused(tenant.id, senderNumber)) {
            console.log(`⏸️  AI is paused for ${senderNumber} on ${tenant.name} (human takeover active — ${takeoverService.getRemainingTime(tenant.id, senderNumber)})`);
            return res.status(200).json({ status: 'paused', reason: 'human takeover active' });
        }

        console.log(`\n📩 Message from ${pushName} (${senderNumber}) to ${tenant.name}: "${messageText}"`);

        // Add user message to conversation history (with DB persistence)
        await conversationService.addMessage(tenant.id, senderNumber, 'user', messageText, pushName);

        // Get conversation history for context
        const history = await conversationService.getHistory(tenant.id, senderNumber);

        // Generate AI response 
        console.log(`🤔 Generating AI response for ${tenant.name}...`);
        const aiResponse = await aiService.generateResponse(tenant, history);

        // Add AI response to conversation history
        await conversationService.addMessage(tenant.id, senderNumber, 'assistant', aiResponse);

        // Send reply back through Evolution API with specific instance
        await evolutionService.sendText(tenant.instanceName, senderNumber, aiResponse);

        // ─── LEAD CAPTURE: Auto-capture lead from customer message ───
        const interest = leadService.extractInterest(messageText);
        leadService.captureLead(tenant.id, senderNumber, pushName, interest);

        console.log(`✅ Conversation handled on ${tenant.name} | Active chats: ${conversationService.getActiveCount()} | Paused chats: ${takeoverService.getPausedCount()} | Products: ${productService.getCount(tenant.id)}`);

        return res.status(200).json({ status: 'processed' });
    } catch (error) {
        console.error('❌ Webhook processing error:', error.message);
        return res.status(200).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
