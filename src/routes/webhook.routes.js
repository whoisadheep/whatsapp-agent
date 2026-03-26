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
const ttsService = require('../services/tts.service');
const broadcastService = require('../services/broadcast.service');

const router = express.Router();

// Track server start time to ignore old messages replayed on reconnect
// Subtracting 10 minutes (600 seconds) to account for Docker/WSL2 clock drift
const SERVER_START_TIME = Math.floor(Date.now() / 1000) - 600;
console.log(`🕐 Server start timestamp: ${SERVER_START_TIME} — messages before this will be ignored`);

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Classify the intent of an incoming message for context hints.
 * Returns a short string injected into conversation history so the AI
 * always has useful context even when image download fails.
 */
function classifyImageContext(caption) {
    if (!caption) return null;
    const text = caption.toLowerCase();

    if (text.match(/upi|pay|paid|payment|transaction|gpay|phonepe|paytm|bank|transfer|₹|\d{3,}/))
        return 'PAYMENT_SCREENSHOT';
    if (text.match(/invoice|bill|receipt|order/))
        return 'INVOICE_OR_BILL';
    if (text.match(/product|item|catalog|price|rate/))
        return 'PRODUCT_IMAGE';
    if (text.match(/cctv|camera|biometric|device|model/))
        return 'PRODUCT_QUERY_IMAGE';
    if (text.match(/location|map|address|site|place/))
        return 'LOCATION_IMAGE';
    return 'GENERAL_IMAGE';
}

/**
 * Build a rich context string for the conversation history when an image arrives.
 * This ensures the AI always has useful info even if download failed.
 */
function buildImageContextText(imageDownloaded, caption, imageType) {
    const type = imageType || classifyImageContext(caption) || 'GENERAL_IMAGE';

    let context = `[CUSTOMER SENT AN IMAGE`;
    if (caption) context += ` with caption: "${caption}"`;

    // Add semantic hints based on detected type
    switch (type) {
        case 'PAYMENT_SCREENSHOT':
            context += ` — This appears to be a UPI/payment screenshot. The customer likely wants to confirm their payment or needs help related to this transaction.`;
            break;
        case 'INVOICE_OR_BILL':
            context += ` — This appears to be an invoice or bill. Help the customer with their billing query.`;
            break;
        case 'PRODUCT_IMAGE':
        case 'PRODUCT_QUERY_IMAGE':
            context += ` — This appears to be a product image. Acknowledge it and help identify or advise on the product.`;
            break;
        case 'LOCATION_IMAGE':
            context += ` — This appears to be a location or map image.`;
            break;
        default:
            context += `.`;
    }

    if (!imageDownloaded) {
        context += ` Note: Image could not be loaded for visual analysis — respond based on caption context only.`;
    }

    context += `]`;
    return context;
}

// Process incoming webhook events from Evolution API
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const event = body.event;

        // Handle connection updates
        if (event === 'connection.update') {
            const state = body.data?.state;
            console.log(`📱 Connection update: ${state}`);
            if (state === 'open') console.log('✅ WhatsApp connected successfully!');
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

        // ─── SKIP OLD MESSAGES ───────────────────────────────────────────────
        const messageTimestamp = data.messageTimestamp || data.key?.messageTimestamp || 0;
        if (messageTimestamp && messageTimestamp < SERVER_START_TIME) {
            return res.status(200).json({ status: 'ignored', reason: 'old message (before server start)' });
        }

        // ─── IDENTIFY TENANT ────────────────────────────────────────────────
        const instanceName = body.instance || body.instanceName;
        const tenant = tenantService.getTenantByInstance(instanceName);
        if (!tenant) {
            console.log(`⚠️  Webhook received for unknown instance: ${instanceName}, ignoring`);
            return res.status(200).json({ status: 'ignored', reason: 'unknown tenant' });
        }

        const remoteJid = data.key?.remoteJid || '';
        const senderNumber = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');

        // ─── OWNER COMMANDS ──────────────────────────────────────────────────
        if (data.key?.fromMe) {
            const messageText =
                data.message?.conversation ||
                data.message?.extendedTextMessage?.text || '';

            const command = messageText.trim().toLowerCase();

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

            if (messageText.trim().toLowerCase().startsWith('#add ')) {
                const parts = messageText.trim().substring(5).split('|').map(s => s.trim());
                const name = parts[0] || '';
                const price = parts[1] || '';
                const description = parts[2] || '';
                if (!name) return res.status(200).json({ status: 'error', reason: 'missing product name' });
                const product = await productService.addProduct(tenant.id, name, price, description);
                if (product) {
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

            if (command.startsWith('#pair ')) {
                const pairNumber = command.substring(6).trim().replace(/\D/g, '');
                if (!pairNumber) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ Please provide a valid number. Example: #pair 919005149776');
                    return res.status(200).json({ status: 'error', reason: 'invalid pairing number' });
                }
                const code = await evolutionService.getPairingCode(tenant.instanceName, pairNumber);
                if (code) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `🔗 *Pairing Code for ${tenant.name}*\n\n🔢 Code: *${code}*\n\nSteps:\n1. Open WhatsApp -> Linked Devices\n2. Link a Device -> *Link with phone number instead*\n3. Enter the code above.`
                    );
                } else {
                    await evolutionService.sendText(tenant.instanceName, senderNumber, '❌ Failed to generate pairing code. Ensure the instance is not already connected.');
                }
                return res.status(200).json({ status: 'pairing_code_generated' });
            }

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

            // --- BROADCAST COMMANDS ---
            if (command.startsWith('#broadcast ')) {
                const parts = messageText.trim().substring(11).split('|').map(s => s.trim());
                const subCommand = parts[0]?.toLowerCase();

                // #broadcast status
                if (subCommand === 'status') {
                    const activeJob = broadcastService.getActiveJob(tenant.id);
                    if (!activeJob) {
                        const history = await broadcastService.getHistory(tenant.id, 1);
                        if (history.length > 0) {
                            const last = history[0];
                            await evolutionService.sendText(tenant.instanceName, senderNumber,
                                `📊 *Last Broadcast Status* — Job #${last.id}\n\n` +
                                `Status: ${last.status.toUpperCase()}\n` +
                                `Sent: ${last.sent} | Failed: ${last.failed}\n` +
                                `Completed: ${new Date(last.completed_at).toLocaleString()}`
                            );
                        } else {
                            await evolutionService.sendText(tenant.instanceName, senderNumber, 'ℹ️ No broadcast history found.');
                        }
                    } else {
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            `📢 *Broadcast in progress* — Job #${activeJob.jobId}\n\n` +
                            `Check your notifications for progress updates.`
                        );
                    }
                    return res.status(200).json({ status: 'broadcast_status' });
                }

                // #broadcast stop
                if (subCommand === 'stop') {
                    const stopped = broadcastService.cancel(tenant.id);
                    if (stopped) {
                        await evolutionService.sendText(tenant.instanceName, senderNumber, '🛑 Stopping broadcast... you will receive a final update shortly.');
                    } else {
                        await evolutionService.sendText(tenant.instanceName, senderNumber, '⚠️ No active broadcast to stop.');
                    }
                    return res.status(200).json({ status: 'broadcast_stopped' });
                }

                // #broadcast send | audience | message
                if (subCommand === 'send') {
                    const audience = parts[1] || 'all';
                    const message = parts[2];

                    if (!message) {
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            '⚠️ Missing message. Format: #broadcast send | audience | Your message here\n\n' +
                            'Audience types: all, leads, new_leads, customers'
                        );
                        return res.status(200).json({ status: 'error', reason: 'missing broadcast message' });
                    }

                    try {
                        const { jobId, total } = await broadcastService.start(tenant, audience, message, senderNumber);
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            `🚀 *Broadcast Started!* — Job #${jobId}\n\n` +
                            `Target: ${total} contacts (${audience})\n` +
                            `I will send you progress updates every 25 messages.`
                        );
                    } catch (err) {
                        await evolutionService.sendText(tenant.instanceName, senderNumber, `❌ Error: ${err.message}`);
                    }
                    return res.status(200).json({ status: 'broadcast_started' });
                }

                await evolutionService.sendText(tenant.instanceName, senderNumber,
                    `📢 *Broadcast Commands:*\n\n` +
                    `• #broadcast send | audience | message\n` +
                    `• #broadcast status\n` +
                    `• #broadcast stop\n\n` +
                    `_Audiences: all, leads, new_leads, customers_`
                );
                return res.status(200).json({ status: 'broadcast_help' });
            }

            // Any other manual reply from owner → auto-pause AI for this contact
            if (!command.startsWith('#')) {
                takeoverService.pause(tenant, senderNumber);
                console.log(`🤝 Owner replied manually to ${senderNumber} on ${tenant.name} — AI paused automatically`);
            }

            return res.status(200).json({ status: 'ignored', reason: 'fromMe' });
        }

        // ─── GROUP FILTER ────────────────────────────────────────────────────
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

        // ─── EXTRACT MESSAGE CONTENT ─────────────────────────────────────────
        const message = data.message;
        const imageMessage = message?.imageMessage;
        const audioMessage = message?.audioMessage;

        let messageText =
            message?.conversation ||
            message?.extendedTextMessage?.text ||
            imageMessage?.caption ||
            message?.videoMessage?.caption ||
            null;

        // ─── VOICE MESSAGE HANDLING ───────────────────────────────────────────
        if (audioMessage) {
            console.log(`🎙️  Voice message detected (${data.key.id}), downloading...`);
            const audioBase64 = await evolutionService.downloadMedia(tenant.instanceName, data.key.id);
            if (audioBase64) {
                const mimeType = audioMessage.mimetype || 'audio/ogg';
                console.log(`🎙️  Transcribing voice message (${mimeType})...`);
                const transcribedText = await transcriptionService.transcribe(audioBase64, mimeType);
                if (transcribedText) {
                    messageText = transcribedText;
                    console.log(`🎙️  Voice transcribed: "${transcribedText.slice(0, 100)}${transcribedText.length > 100 ? '...' : ''}"`);
                } else {
                    console.error('❌ Voice transcription failed, replying with error');
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        "Sorry, I couldn't understand your voice message. Could you please type your message instead?"
                    );
                    return res.status(200).json({ status: 'processed', reason: 'voice transcription failed' });
                }
            } else {
                console.error('❌ Failed to download voice message');
                return res.status(200).json({ status: 'error', reason: 'voice download failed' });
            }
        }

        if (!messageText && !imageMessage) {
            console.log('⏭️  Non-text, non-image, and non-audio message received, skipping');
            return res.status(200).json({ status: 'ignored', reason: 'unsupported message type' });
        }

        const pushName = data.pushName || 'Customer';

        // ─── BROADCAST OPT-OUT HANDLING ──────────────────────────────────────
        if (messageText && (messageText.toUpperCase() === 'STOP' || messageText.toUpperCase() === 'UNSUBSCRIBE')) {
            const optedOut = await broadcastService.optOut(tenant.id, senderNumber);
            if (optedOut) {
                await evolutionService.sendText(tenant.instanceName, senderNumber,
                    `🚫 You have been opted out of future broadcasts from ${tenant.name}. You can still message us here anytime for help!`
                );
                return res.status(200).json({ status: 'opt_out_success', contact: senderNumber });
            }
        }

        // ─── IMAGE HANDLING ──────────────────────────────────────────────────
        // FIX: Detect image type from caption BEFORE downloading, so even if
        // download fails we can still give the AI useful context.
        let imageData = null;
        let imageContextText = null;

        if (imageMessage) {
            const caption = imageMessage.caption || '';
            const detectedType = classifyImageContext(caption);
            console.log(`🖼️  Image message detected (type: ${detectedType || 'GENERAL'}, id: ${data.key.id}), downloading...`);

            imageData = await evolutionService.downloadMedia(tenant.instanceName, data.key.id);

            if (imageData) {
                console.log(`✅ Image downloaded successfully (${Math.round(imageData.length / 1024)} KB base64)`);
            } else {
                console.warn('⚠️  Image download failed — AI will respond using caption context only');
            }

            // Always build rich context text for the conversation history
            imageContextText = buildImageContextText(!!imageData, caption, detectedType);
        }

        // ─── IGNORED NUMBERS ─────────────────────────────────────────────────
        const ignoredNumbers = tenant.ignoredNumbers || [];
        if (ignoredNumbers.includes(senderNumber)) {
            console.log(`⏭️  Message from ignored number ${senderNumber} on ${tenant.name}, skipping`);
            return res.status(200).json({ status: 'ignored', reason: 'ignored number' });
        }

        // ─── HUMAN TAKEOVER CHECK ─────────────────────────────────────────────
        if (takeoverService.isPaused(tenant.id, senderNumber)) {
            console.log(`⏸️  AI is paused for ${senderNumber} on ${tenant.name} (${takeoverService.getRemainingTime(tenant.id, senderNumber)})`);
            return res.status(200).json({ status: 'paused', reason: 'human takeover active' });
        }

        const mediaTag = audioMessage ? 'VOICE' : (imageMessage ? 'IMAGE' : '');
        console.log(`\n📩 Message [${mediaTag ? mediaTag + ' + ' : ''}${messageText || 'No text'}] from ${pushName} (${senderNumber}) → ${tenant.name}`);

        // ─── BUILD CONVERSATION HISTORY ENTRY ────────────────────────────────
        // FIX: For images, store the rich semantic context string instead of the
        // bare "[SENT AN IMAGE]" placeholder. This gives the AI real context to work with.
        let processedText;
        if (audioMessage) {
            processedText = `[SENT A VOICE MESSAGE] ${messageText || ''}`;
        } else if (imageMessage) {
            // Use the rich context; append any text the user also typed alongside the image
            processedText = imageContextText;
            if (messageText && !imageMessage.caption) {
                // User typed extra text not already in the caption
                processedText += ` User also wrote: "${messageText}"`;
            }
        } else {
            processedText = messageText;
        }

        await conversationService.addMessage(tenant.id, senderNumber, 'user', processedText, pushName);

        // Get conversation history for context
        const history = await conversationService.getHistory(tenant.id, senderNumber);

        // ─── GENERATE AI RESPONSE ─────────────────────────────────────────────
        console.log(`🤔 Generating AI response for ${tenant.name}...`);
        const aiResponse = await aiService.generateResponse(tenant, history, imageData);

        // Add AI response to conversation history
        await conversationService.addMessage(tenant.id, senderNumber, 'assistant', aiResponse);

        // ─── AI TRIGGER TAGS ──────────────────────────────────────────────────
        const qrTagRegex = /[\*\[]SEND_UPI_QR[\*\]]/i;
        const leadTagRegex = /[\*\[]SEND_LEAD_SUMMARY[\*\]]/i;

        const shouldSendQr = qrTagRegex.test(aiResponse) && tenant.upiId;
        const shouldSendLeadSummary = leadTagRegex.test(aiResponse);

        const cleanedResponse = aiResponse
            .replace(new RegExp(qrTagRegex, 'gi'), '')
            .replace(new RegExp(leadTagRegex, 'gi'), '')
            .trim();

        // ─── SEND REPLY ───────────────────────────────────────────────────────
        let voiceSent = false;
        if (audioMessage && ttsService.isAvailable()) {
            try {
                console.log('🔊 Generating voice reply via Edge TTS...');
                const audioBase64 = await ttsService.textToSpeech(cleanedResponse);
                if (audioBase64) {
                    await evolutionService.sendAudio(tenant.instanceName, senderNumber, audioBase64);
                    voiceSent = true;
                    console.log('🔊 Voice reply sent successfully');
                }
            } catch (ttsError) {
                console.error('⚠️  Voice reply failed, falling back to text:', ttsError.message);
            }
        }

        if (!voiceSent) {
            await evolutionService.sendText(tenant.instanceName, senderNumber, cleanedResponse);
        }

        // ─── SEND UPI QR ──────────────────────────────────────────────────────
        if (shouldSendQr) {
            console.log(`💳 AI triggered UPI QR for ${senderNumber} on ${tenant.name}`);
            let qrBase64 = await paymentService.getStaticQr(tenant.id);
            if (!qrBase64) {
                console.log(`ℹ️  No static QR found for ${tenant.id}, generating dynamically...`);
                qrBase64 = await paymentService.generateUpiQr(tenant.upiId, tenant.upiName || tenant.name);
            }
            if (qrBase64) {
                await evolutionService.sendImage(tenant.instanceName, senderNumber, qrBase64,
                    `💳 *Pay ${tenant.upiName || tenant.name}*\n\nScan this QR code with any UPI app (Google Pay, PhonePe, Paytm, etc.)`
                );
            }
        }

        // ─── SEND LEAD SUMMARY TO OWNER ───────────────────────────────────────
        if (shouldSendLeadSummary && tenant.ownerPhone) {
            console.log(`📋 AI triggered Lead Summary for ${senderNumber} on ${tenant.name}`);
            const recentMsgs = history.slice(-6)
                .map(m => `${m.role === 'assistant' ? 'AI' : 'Customer'}: ${m.content}`)
                .join('\n\n');
            const summaryMessage =
                `🔔 *New Lead Collected!* — ${tenant.name}\n\n` +
                `📞 Customer Phone: ${senderNumber}\n` +
                `👤 Customer Name: ${pushName}\n\n` +
                `*Recent context:*\n${recentMsgs}\n\n` +
                `_Reply with #ai off to take over this chat manually._`;
            await evolutionService.sendText(tenant.instanceName, tenant.ownerPhone, summaryMessage);
        }

        // ─── AUTO LEAD CAPTURE ────────────────────────────────────────────────
        const interest = leadService.extractInterest(messageText);
        leadService.captureLead(tenant.id, senderNumber, pushName, interest);

        console.log(`✅ ${tenant.name} | Active chats: ${conversationService.getActiveCount()} | Paused: ${takeoverService.getPausedCount()} | Products: ${productService.getCount(tenant.id)}`);
        return res.status(200).json({ status: 'processed' });

    } catch (error) {
        console.error('❌ Webhook processing error:', error.message);
        return res.status(200).json({ status: 'error', message: error.message });
    }
});

module.exports = router;