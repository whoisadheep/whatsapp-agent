const express = require('express');
const evolutionService = require('../services/evolution.service');
const aiService = require('../services/ai.service');
const conversationService = require('../services/conversation.service');
const takeoverService = require('../services/takeover.service');
const productService = require('../services/product.service');
const leadService = require('../services/lead.service');
const tenantService = require('../services/tenant.service');
const paymentService = require('../services/payment.service');
const transcriptionService = require('../services/transcription.service');
const reviewService = require('../services/review.service');

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

            // ─── PAIRING COMMAND ───
            if (command.startsWith('#pair ')) {
                const pairNumber = command.substring(6).trim().replace(/\D/g, '');
                if (!pairNumber) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ Please provide a valid number. Example: #pair 919005149776');
                    return res.status(200).json({ status: 'error', reason: 'invalid pairing number' });
                }

                const code = await evolutionService.getPairingCode(tenant.instanceName, pairNumber);
                if (code) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, 
                        `🔗 *Pairing Code for ${tenant.name}*\n\n` +
                        `🔢 Code: *${code}*\n\n` +
                        `Steps for the owner:\n` +
                        `1. Open WhatsApp -> Linked Devices\n` +
                        `2. Link a Device -> *Link with phone number instead*\n` +
                        `3. Enter the code above.`
                    );
                } else {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '❌ Failed to generate pairing code. Ensure the instance is not already connected.');
                }
                    return res.status(200).json({ status: 'pairing_code_generated' });
            }

            // ─── BILL / PAYMENT COMMAND ───
            if (command.startsWith('#bill ')) {
                const billParts = messageText.trim().substring(6).split('|').map(s => s.trim());
                const amount = parseFloat(billParts[0]) || 0;
                const description = billParts[1] || 'Payment';

                if (!tenant.upiId) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ UPI is not configured for this tenant.');
                    return res.status(200).json({ status: 'error', reason: 'upi not configured' });
                }

                const qrBase64 = await paymentService.generateUpiQr(tenant.upiId, tenant.upiName || tenant.name, amount, description);
                if (qrBase64) {
                    await evolutionService.sendImage(tenant.instanceName, senderNumber, qrBase64,
                        `💳 *Payment Request — ${tenant.name}*\n\n💰 Amount: ₹${amount}\n📝 ${description}\n\nScan this QR code with any UPI app to pay.`
                    );
                } else {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '❌ Failed to generate payment QR code.');
                }
                return res.status(200).json({ status: 'bill_sent' });
            }

            // ─── GOOGLE REVIEW BOOSTER COMMAND ───
            if (command.startsWith('#review ')) {
                const reviewParts = messageText.trim().substring(8).split('|').map(s => s.trim());
                const customerName = reviewParts[0] || 'Customer';
                const customerPhone = reviewParts[1] || '';

                if (!customerPhone) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ Please provide a valid number. Example: #review Kishan | 919876543210');
                    return res.status(200).json({ status: 'error', reason: 'invalid review number' });
                }

                if (!tenant.reviewLink) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ Google Review Link is not configured for this tenant.');
                    return res.status(200).json({ status: 'error', reason: 'review link not configured' });
                }

                const scheduled = await reviewService.scheduleReview(tenant.id, customerName, customerPhone);
                if (scheduled) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, 
                        `✅ Scheduled a Google review request for *${customerName}* in 1 hour.`
                    );
                } else {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '❌ Failed to schedule review request (DB error).');
                }
                return res.status(200).json({ status: 'review_scheduled' });
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

        // Extract message text and media
        const message = data.message;
        const imageMessage = message?.imageMessage;
        
        const messageText =
            message?.conversation ||
            message?.extendedTextMessage?.text ||
            imageMessage?.caption ||
            message?.videoMessage?.caption ||
            null;

        if (!messageText && !imageMessage) {
            console.log('⏭️  Non-text and non-image message received, skipping');
            return res.status(200).json({ status: 'ignored', reason: 'non-text message' });
        }

        const pushName = data.pushName || 'Customer';

        // ─── IMAGE HANDLING: Download image if message is a photo ───
        let imageData = null;
        if (imageMessage) {
            console.log(`🖼️  Image message detected (${data.key.id}), downloading...`);
            imageData = await evolutionService.downloadMedia(tenant.instanceName, data.key.id);
            if (imageData) {
                console.log('✅ Image downloaded successfully');
            }
        }

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

        console.log(`\n📩 Message content [${imageMessage ? 'IMAGE + ' : ''}${messageText || 'No text'}] from ${pushName} (${senderNumber}) to ${tenant.name}`);

        // Add user message to conversation history (with DB persistence)
        // If image, we note it in text for context history
        const processedText = imageMessage ? `[SENT AN IMAGE] ${messageText || ''}` : messageText;
        await conversationService.addMessage(tenant.id, senderNumber, 'user', processedText, pushName);

        // Get conversation history for context
        const history = await conversationService.getHistory(tenant.id, senderNumber);

        // Generate AI response 
        console.log(`🤔 Generating AI response for ${tenant.name}...`);
        const aiResponse = await aiService.generateResponse(tenant, history, imageData);

        // Add AI response to conversation history
        await conversationService.addMessage(tenant.id, senderNumber, 'assistant', aiResponse);

        // ─── AI TRIGGERS: Check if AI wants to send a payment QR or a lead summary ───
        const cleanedResponse = aiResponse.replace(/\[SEND_UPI_QR\]/gi, '').replace(/\[SEND_LEAD_SUMMARY\]/gi, '').trim();
        const shouldSendQr = aiResponse.includes('[SEND_UPI_QR]') && tenant.upiId;
        const shouldSendLeadSummary = aiResponse.includes('[SEND_LEAD_SUMMARY]');

        // Send reply back through Evolution API with specific instance
        await evolutionService.sendText(tenant.instanceName, senderNumber, cleanedResponse);

        // If AI triggered a QR, generate and send it
        if (shouldSendQr) {
            console.log(`💳 AI triggered UPI QR for ${senderNumber} on ${tenant.name}`);
            const qrBase64 = await paymentService.generateUpiQr(tenant.upiId, tenant.upiName || tenant.name);
            if (qrBase64) {
                await evolutionService.sendImage(tenant.instanceName, senderNumber, qrBase64,
                    `💳 *Pay ${tenant.upiName || tenant.name}*\n\nScan this QR code with any UPI app (Google Pay, PhonePe, Paytm, etc.)`
                );
            }
        }

        // If AI triggered a Lead Summary, send context to the owner
        if (shouldSendLeadSummary && tenant.ownerPhone) {
            console.log(`📋 AI triggered Lead Summary for ${senderNumber} on ${tenant.name}`);
            
            // Generate a summary query using AI or just send the recent history
            // For speed, let's just send the last 5-6 messages between user and AI
            const recentMsgs = history.slice(-6).map(m => `${m.role === 'assistant' ? 'AI' : 'Customer'}: ${m.content}`).join('\n\n');
            const summaryMessage = `🔔 *New Lead Collected!* — ${tenant.name}\n\n📞 Customer Phone: ${senderNumber}\n👤 Customer Name: ${pushName}\n\n*Recent context:*\n${recentMsgs}\n\n_Reply with #ai off to take over this chat manually._`;
            
            await evolutionService.sendText(tenant.instanceName, tenant.ownerPhone, summaryMessage);
        }

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
