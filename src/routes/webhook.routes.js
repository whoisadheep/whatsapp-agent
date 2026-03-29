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
const broadcastService = require('../services/broadcast.service'); // ← NEW

const router = express.Router();

// Track server start time to ignore old messages replayed on reconnect
// Subtracting 10 minutes (600 seconds) to account for Docker/WSL2 clock drift
const SERVER_START_TIME = Math.floor(Date.now() / 1000) - 600;
console.log(`🕐 Server start timestamp: ${SERVER_START_TIME} — messages before this will be ignored`);

// ─── ANTI-DUPLICATE CACHE ───
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 200;

// ─── DEBOUNCER STATE ───
// We map chatKey -> { timer, imageData, audioMessage } so we don't lose media during rapid-fire texts
const typingState = new Map();
const BATCH_DELAY_MS = 4000; // Wait 4 seconds after their last message before replying

// ─── IMAGE CONTEXT HELPERS ───────────────────────────────────────────────────
// Classify image type from caption keywords
function classifyImageContext(caption) {
    if (!caption) return null;
    const text = caption.toLowerCase();
    if (text.match(/upi|pay|paid|payment|transaction|gpay|phonepe|paytm|bank|transfer|₹|\d{4,}/))
        return 'PAYMENT_SCREENSHOT';
    if (text.match(/invoice|bill|receipt|order/))
        return 'INVOICE_OR_BILL';
    if (text.match(/cctv|camera|biometric|device|model|panel|product|item/))
        return 'PRODUCT_IMAGE';
    if (text.match(/location|map|address|site/))
        return 'LOCATION_IMAGE';
    if (text.match(/mahakal|shiv|durga|ganesh|hanuman|aarti|mandir|festival|diwali|holi|eid|navratri|puja|prasad|🙏|🪔|🕉️/))
        return 'FESTIVAL_IMAGE';
    return null;
}

// Build rich context string so AI always has meaningful guidance
function buildImageContextText(imageDownloaded, caption, imageType) {
    const type = imageType || classifyImageContext(caption) || 'GENERAL_IMAGE';
    let context = '[CUSTOMER SENT AN IMAGE';
    if (caption) context += ` with caption: "${caption}"`;

    switch (type) {
        case 'PAYMENT_SCREENSHOT':
            context += ' — This is a UPI/payment screenshot. Warmly acknowledge the payment and ask which product/service it is for. NEVER refuse to help.';
            break;
        case 'INVOICE_OR_BILL':
            context += ' — This is an invoice or bill. Help with the billing query.';
            break;
        case 'PRODUCT_IMAGE':
            context += ' — Customer sent a product image. Ask a SHORT clarifying question (e.g., "Yeh product chahiye aapko? Price batata hoon."). Do NOT write a long description.';
            break;
        case 'FESTIVAL_IMAGE':
            context += ' — Customer sent a festival or religious greeting image. Reply with a warm, brief festival wish in Hinglish (e.g., "Jai Shiv Shambhu! 🙏 Koi madad chahiye to batayen."). Do NOT pitch products.';
            break;
        case 'LOCATION_IMAGE':
            context += ' — Customer sent a location/map image.';
            break;
        default:
            context += ' — This is likely a social/greeting/forwarded image. Reply warmly and briefly. Do NOT ask "what product do you want?" or treat it as a business inquiry. Simply say something friendly like "Message mila! Koi madad chahiye to batayen 😊"';
    }

    if (!imageDownloaded) {
        context += ' Image could not be loaded — respond based on caption context only.';
    }

    context += ']';
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

        // ─── DEDUPLICATION CHECK ───
        const messageId = data.key?.id;
        if (messageId) {
            if (processedMessageIds.has(messageId)) {
                return res.status(200).json({ status: 'ignored', reason: 'duplicate message' });
            }
            processedMessageIds.add(messageId);
            if (processedMessageIds.size > MAX_PROCESSED_IDS) {
                const iterator = processedMessageIds.values();
                processedMessageIds.delete(iterator.next().value);
            }
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
            // FIX: Also read image captions so owner can attach a photo to #broadcast
            const ownerImageMessage = data.message?.imageMessage;
            const messageText =
                data.message?.conversation ||
                data.message?.extendedTextMessage?.text ||
                ownerImageMessage?.caption ||          // ← image caption as command
                '';

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

            // ─── BROADCAST COMMAND ───────────────────────────────────────
            // Usage:
            //   #broadcast preview | all | Your message
            //   #broadcast all | Your message
            //   #broadcast leads | Your message
            //   #broadcast new_leads | Your message
            //   #broadcast customers | Your message
            //   #broadcast stop
            //   #broadcast history
            if (messageText.trim().toLowerCase().startsWith('#broadcast')) {
                const rawText = messageText.trim();
                const subCmd = rawText.substring(10).trim();

                // ── STOP ──
                if (subCmd.toLowerCase() === 'stop') {
                    const cancelled = broadcastService.cancel(tenant.id);
                    if (cancelled) {
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            '🛑 Broadcast cancellation requested. Will stop after current message.'
                        );
                    } else {
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            '⚠️ No active broadcast to stop.'
                        );
                    }
                    return res.status(200).json({ status: 'broadcast_stop' });
                }

                // ── HISTORY ──
                if (subCmd.toLowerCase() === 'history') {
                    const history = await broadcastService.getHistory(tenant.id, 5);
                    if (history.length === 0) {
                        await evolutionService.sendText(tenant.instanceName, senderNumber, '📢 No broadcasts sent yet.');
                    } else {
                        let msg = `📢 *Broadcast History* (last ${history.length})\n\n`;
                        history.forEach((j, i) => {
                            const date = new Date(j.started_at).toLocaleDateString('en-IN', {
                                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                            });
                            msg += `${i + 1}. *Job #${j.id}* — ${j.status.toUpperCase()}\n`;
                            msg += `   📅 ${date} | 👥 ${j.audience}\n`;
                            msg += `   ✅ ${j.sent}/${j.total} sent | ❌ ${j.failed} failed\n`;
                            msg += `   _"${j.message_preview}..."_\n\n`;
                        });
                        await evolutionService.sendText(tenant.instanceName, senderNumber, msg);
                    }
                    return res.status(200).json({ status: 'broadcast_history' });
                }

                // ── PREVIEW or SEND ──
                // Format: #broadcast [preview|all|leads|new_leads|customers] | message
                const parts = subCmd.split('|').map(s => s.trim());
                const modeOrAudience = (parts[0] || '').toLowerCase();
                const isPreview = modeOrAudience === 'preview';

                let audience, broadcastMessage;
                if (isPreview) {
                    audience = (parts[1] || 'all').toLowerCase();
                    broadcastMessage = parts.slice(2).join('|').trim();
                } else {
                    audience = modeOrAudience;
                    broadcastMessage = parts.slice(1).join('|').trim();
                }

                const validAudiences = ['all', 'leads', 'new_leads', 'customers'];
                if (!validAudiences.includes(audience)) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `⚠️ Invalid audience. Use: *all*, *leads*, *new_leads*, or *customers*\n\n` +
                        `Example: #broadcast all | Happy Diwali! 🎉 Special 20% off today only.`
                    );
                    return res.status(200).json({ status: 'broadcast_invalid_audience' });
                }

                if (!broadcastMessage) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `⚠️ No message provided.\n\n` +
                        `Usage:\n` +
                        `• #broadcast all | Your message\n` +
                        `• #broadcast leads | Your message\n` +
                        `• #broadcast preview | all | Your message\n\n` +
                        `Tip: Use {name} to personalise — e.g. "Hi {name}, special offer for you!"`
                    );
                    return res.status(200).json({ status: 'broadcast_no_message' });
                }

                if (!isPreview && broadcastService.isRunning(tenant.id)) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `⚠️ A broadcast is already running. Send *#broadcast stop* to cancel it first.`
                    );
                    return res.status(200).json({ status: 'broadcast_already_running' });
                }

                // ── IMAGE ATTACHMENT: Download if owner attached a photo ──
                let broadcastImageBase64 = null;
                let broadcastImageMime = null;
                if (ownerImageMessage) {
                    console.log(`🖼️  Owner attached image to broadcast, downloading...`);
                    broadcastImageBase64 = await evolutionService.downloadMedia(tenant.instanceName, data.key.id);
                    broadcastImageMime = ownerImageMessage.mimetype || 'image/jpeg';
                    if (broadcastImageBase64) {
                        console.log(`✅ Broadcast image ready (${Math.round(broadcastImageBase64.length / 1024)} KB)`);
                    } else {
                        console.warn('⚠️  Broadcast image download failed — sending text only');
                    }
                }

                try {
                    if (isPreview) {
                        const info = await broadcastService.preview(tenant.id, audience, broadcastMessage);
                        const hasImage = !!broadcastImageBase64;
                        await evolutionService.sendText(tenant.instanceName, senderNumber,
                            `📢 *Broadcast Preview*\n\n` +
                            `👥 Audience: *${audience}*\n` +
                            `📨 Recipients: *${info.recipientCount}*\n` +
                            `🚫 Opted out: ${info.optOutCount}\n` +
                            `📸 With image: ${hasImage ? 'Yes ✅' : 'No (text only)'}\n` +
                            `⏱️ Est. time: ~${info.estimatedTimeMin} min\n\n` +
                            `*Sample recipients:*\n` +
                            info.sampleRecipients.map(r => `• ${r.name} (${r.phone})`).join('\n') +
                            `\n\n*Message preview:*\n_"${info.messageSample}"_\n\n` +
                            `To send, attach same image and use:\n#broadcast ${audience} | ${broadcastMessage}`
                        );
                        return res.status(200).json({ status: 'broadcast_preview' });
                    }

                    const { jobId, total } = await broadcastService.start(
                        tenant, audience, broadcastMessage, senderNumber,
                        broadcastImageBase64, broadcastImageMime
                    );
                    const imageNote = broadcastImageBase64 ? '\n📸 Image attached' : '';
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `📢 *Broadcast started!* — Job #${jobId}\n\n` +
                        `👥 Audience: ${audience}\n` +
                        `📨 Recipients: ${total}${imageNote}\n\n` +
                        `Progress updates every 25 messages.\n` +
                        `Send *#broadcast stop* to cancel.`
                    );
                } catch (err) {
                    await evolutionService.sendText(tenant.instanceName, senderNumber,
                        `❌ Broadcast failed: ${err.message}`
                    );
                }
                return res.status(200).json({ status: 'broadcast_started' });
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
            if (!command.startsWith('#') && messageText.trim() !== '') {
                // ─── LOG OWNER MANUAL REPLIES ───
                let loggedText = messageText;
                if (ownerImageMessage) loggedText = `[Sent an Image] ${messageText}`;
                else if (data.message?.videoMessage) loggedText = `[Sent a Video] ${messageText}`;

                await conversationService.addMessage(tenant.id, senderNumber, 'assistant', `[Owner Manually Sent]: ${loggedText}`);

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

        // Extract message text, media, AND QUOTED CONTEXT
        const message = data.message;
        const imageMessage = message?.imageMessage;
        const audioMessage = message?.audioMessage;
        const videoMessage = message?.videoMessage;
        const extendedTextMessage = message?.extendedTextMessage;

        const contextInfo = extendedTextMessage?.contextInfo ||
            imageMessage?.contextInfo ||
            videoMessage?.contextInfo;

        let messageText =
            message?.conversation ||
            extendedTextMessage?.text ||
            imageMessage?.caption ||
            videoMessage?.caption ||
            null;

        let quotedText = null;
        if (contextInfo?.quotedMessage) {
            const qm = contextInfo.quotedMessage;
            quotedText = qm.conversation ||
                qm.extendedTextMessage?.text ||
                qm.imageMessage?.caption ||
                qm.videoMessage?.caption ||
                '[Media/Video/Image]';
        }

        // ─── VOICE MESSAGE HANDLING: Transcribe audio to text ───
        if (audioMessage) {
            console.log(`🎙️  Voice message detected (${messageId}), downloading...`);
            const audioBase64 = await evolutionService.downloadMedia(tenant.instanceName, messageId);
            if (audioBase64) {
                const mimeType = audioMessage.mimetype || 'audio/ogg';
                console.log(`🎙️  Transcribing voice message (${mimeType})...`);
                const transcribedText = await transcriptionService.transcribe(audioBase64, mimeType);
                if (transcribedText) {
                    messageText = transcribedText;
                    console.log(`🎙️  Voice transcribed: "${transcribedText.slice(0, 100)}${transcribedText.length > 100 ? '...' : ''}"`);
                } else {
                    console.error('❌ Voice transcription failed, replying with error');
                    await evolutionService.sendText(tenant.instanceName, senderNumber, "Sorry, I couldn't understand your voice message. Could you please type your message instead?");
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

        // ─── IMAGE HANDLING: Download image if message is a photo ───
        let imageData = null;
        if (imageMessage) {
            console.log(`🖼️  Image message detected (${messageId}), downloading...`);
            imageData = await evolutionService.downloadMedia(tenant.instanceName, messageId);
            if (imageData) {
                console.log('✅ Image downloaded successfully');
            }
        }

        // ─── CUSTOMER OPT-OUT: Handle "STOP" to unsubscribe from broadcasts ───
        const stopKeywords = ['stop', 'unsubscribe', 'opt out', 'optout', 'no messages', 'band karo', 'mat bhejo'];
        if (messageText && stopKeywords.some(kw => messageText.trim().toLowerCase() === kw)) {
            await broadcastService.optOut(tenant.id, senderNumber);
            await evolutionService.sendText(tenant.instanceName, senderNumber,
                "You've been unsubscribed from broadcast messages. You'll still receive replies to your own messages. Reply *START* to re-subscribe."
            );
            console.log(`🚫 ${senderNumber} opted out of broadcasts on ${tenant.name}`);
            return res.status(200).json({ status: 'optout_registered' });
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

        const mediaTag = audioMessage ? 'VOICE' : (imageMessage ? 'IMAGE' : '');
        console.log(`\n📩 Message content [${mediaTag ? mediaTag + ' + ' : ''}${messageText || 'No text'}] from ${pushName} (${senderNumber}) to ${tenant.name}`);

        // Inject Quoted Context into AI memory
        let processedText = messageText || '';
        if (audioMessage) {
            processedText = `[SENT A VOICE MESSAGE] ${messageText || ''}`;
        } else if (imageMessage) {
            // Use rich semantic context instead of bare "[SENT AN IMAGE]"
            // so the AI knows HOW to respond (festival greeting vs payment vs product)
            const imgCaption = imageMessage.caption || '';
            const imgType = classifyImageContext(imgCaption);
            processedText = buildImageContextText(!!imageData, imgCaption, imgType);
            if (messageText && messageText !== imgCaption) {
                processedText += ` User also wrote: "${messageText}"`;
            }
        }

        // If the customer replied to a specific message, attach it here!
        if (quotedText) {
            processedText = `[Replying to previous message: "${quotedText.substring(0, 100)}..."]\nCustomer says: ${processedText}`;
        }

        // Save to DB immediately so the next webhook sees it
        await conversationService.addMessage(tenant.id, senderNumber, 'user', processedText, pushName);

        // Lead Capture (do this immediately too)
        const interest = leadService.extractInterest(messageText);
        leadService.captureLead(tenant.id, senderNumber, pushName, interest);

        // ─── DEALER PAYMENT INTERCEPT ─────────────────────────────────────────
        // Hardcoded catch for SaiInfotek dealer "pay me" requests BEFORE the AI runs.
        // The AI cannot reliably distinguish "dealer wanting payment" from "customer paying us".
        // We detect it in code, send the safe hardcoded reply, and alert the owner.
        if (messageText && tenant.id === 'sai_infotek') {
            const dealerTriggers = [
                'payment transfer kar', 'mera payment', 'mujhe paise', 'ledger bhejo',
                'outstanding clear', 'baki payment', 'mera amount', 'paisa bhejo',
                'transfer kar de', 'payment kab', 'mera balance', 'settlement karo',
                'mera paisa', 'payment do', 'paise do', 'payment chahiye',
            ];
            const msgLower = messageText.toLowerCase();
            const isDealerRequest = dealerTriggers.some(t => msgLower.includes(t));

            if (isDealerRequest) {
                console.log(`🏪 Dealer payment request from ${senderNumber} on ${tenant.name} — bypassing AI`);

                const dealerReply = 'Namaste! 🙏 Main Kumud sir ka AI assistant hoon. Aapka payment/ledger message main sir ko abhi forward kar raha hoon. Sir aapse jaldi contact karenge. Dhanyawad!';
                await evolutionService.sendText(tenant.instanceName, senderNumber, dealerReply);
                await conversationService.addMessage(tenant.id, senderNumber, 'assistant', dealerReply);

                // Immediately alert the owner
                if (tenant.ownerPhone) {
                    const ownerAlert =
                        `⚠️ *Dealer Payment Request*

` +
                        `📞 From: ${pushName} (${senderNumber})
` +
                        `💬 "${messageText.slice(0, 200)}"

` +
                        `_AI ne politely reply kar diya. Aap directly contact karen._`;
                    evolutionService.sendText(tenant.instanceName, tenant.ownerPhone.replace(/\D/g, ''), ownerAlert).catch(() => { });
                }

                return res.status(200).json({ status: 'dealer_intercepted' });
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  THE DEBOUNCER: Batching rapid-fire messages together
        // ════════════════════════════════════════════════════════════════════
        const chatKey = `${tenant.id}:${senderNumber}`;

        // Initialize state for this chat if it doesn't exist
        if (!typingState.has(chatKey)) {
            typingState.set(chatKey, { timer: null, imageData: null, audioMessage: null });
        }

        const state = typingState.get(chatKey);

        // Preserve media if they sent an image/audio then immediately sent text
        if (imageData) state.imageData = imageData;
        if (audioMessage) state.audioMessage = audioMessage;

        // Reset the timer!
        if (state.timer) {
            clearTimeout(state.timer);
            console.log(`⏱️ Customer ${senderNumber} still typing... extending timer`);
        }

        // Acknowledge the webhook IMMEDIATELY so Evolution API doesn't retry
        res.status(200).json({ status: 'queued_for_batching' });

        // Start the countdown
        state.timer = setTimeout(async () => {
            // Grab the accumulated media before cleaning up
            const finalImageData = state.imageData;
            const finalAudioMsg = state.audioMessage;

            // Clean up the map
            typingState.delete(chatKey);

            try {
                // Get conversation history (this will now contain ALL messages they sent in the last 4 seconds!)
                const history = await conversationService.getHistory(tenant.id, senderNumber);

                // Detect Intent
                const lastMessageText = history.length > 0 ? history[history.length - 1].content : '';
                console.log(`🔍 Detecting intent for: "${lastMessageText.slice(0, 50)}..."`);
                const intent = await aiService.detectIntent(tenant, lastMessageText);
                console.log(`🎯 Detected intent: ${intent}`);

                // Choose Response Strategy
                if (intent === aiService.intents.PERSONAL_UNRELATED) {
                    console.log(`⏭️  Intent is PERSONAL_UNRELATED, skipping AI reply.`);
                    return;
                }

                // Generate AI response 
                console.log(`🤔 Generating AI response for ${tenant.name} (${intent})...`);
                const aiResponse = await aiService.generateResponse(tenant, history, finalImageData, intent);

                // Add AI response to conversation history
                await conversationService.addMessage(tenant.id, senderNumber, 'assistant', aiResponse);

                // ─── AI TRIGGERS ───
                const qrTagRegex = /[\*\[]+SEND_UPI_QR[\*\]]+/i;
                const leadTagRegex = /[\*\[]+SEND_LEAD_SUMMARY[\*\]]+/i;
                const reviewTagRegex = /[\*\[]+SCHEDULE_REVIEW[\*\]]+/i;

                const shouldSendQr = qrTagRegex.test(aiResponse) && tenant.upiId;
                const shouldSendLeadSummary = leadTagRegex.test(aiResponse);
                const shouldScheduleReview = reviewTagRegex.test(aiResponse);

                // Remove tags from the response before sending
                const cleanedResponse = aiResponse
                    .replace(new RegExp(qrTagRegex, 'gi'), '')
                    .replace(new RegExp(leadTagRegex, 'gi'), '')
                    .replace(new RegExp(reviewTagRegex, 'gi'), '')
                    .trim();

                // Send reply back through Evolution API
                let voiceSent = false;
                if (finalAudioMsg && ttsService.isAvailable()) {
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

                if (!voiceSent && typeof cleanedResponse === 'string' && cleanedResponse.trim().length > 0) {
                    console.log(`[DEBUG] AI sending text [${cleanedResponse.length} chars]: ${JSON.stringify(cleanedResponse)}`);
                    await evolutionService.sendText(tenant.instanceName, senderNumber, cleanedResponse);
                } else if (!voiceSent) {
                    console.log(`⏭️ AI response was empty (likely only tags). Content was: ${JSON.stringify(cleanedResponse)}`);
                }

                // If AI triggered a QR
                if (shouldSendQr) {
                    console.log(`💳 AI triggered UPI QR for ${senderNumber} on ${tenant.name}`);
                    let qrBase64 = await paymentService.getStaticQr(tenant.id);
                    if (!qrBase64) {
                        qrBase64 = await paymentService.generateUpiQr(tenant.upiId, tenant.upiName || tenant.name);
                    }
                    if (qrBase64) {
                        await evolutionService.sendImage(tenant.instanceName, senderNumber, qrBase64,
                            `💳 *Pay ${tenant.upiName || tenant.name}*\n\nScan this QR code with any UPI app.`
                        );
                    }
                }

                // If AI triggered a Lead Summary
                if (shouldSendLeadSummary && tenant.ownerPhone) {
                    console.log(`📋 AI triggered Lead Summary for ${senderNumber}`);
                    const recentMsgs = history.slice(-6).map(m => `${m.role === 'assistant' ? 'AI' : 'Customer'}: ${m.content}`).join('\n\n');
                    const summaryMessage = `🔔 *New Lead Collected!* — ${tenant.name}\n\n📞 Customer Phone: ${senderNumber}\n👤 Customer Name: ${pushName}\n\n*Recent context:*\n${recentMsgs}\n\n_Reply with #ai off to take over this chat manually._`;
                    await evolutionService.sendText(tenant.instanceName, tenant.ownerPhone, summaryMessage);
                }

                // ─── REVIEW TRIGGER: Code-level closure detection ─────────────
                // We don't rely on the AI to append [SCHEDULE_REVIEW] — LLMs
                // forget to append tags on short casual messages like "thanks" or
                // "theek hai" which are exactly the right moments to ask for a review.
                //
                // Instead: detect closure signals in the customer's own message,
                // then schedule directly. The AI tag is kept as a secondary trigger
                // for cases the code misses (e.g. longer positive closings).
                //
                // Closure detection: score the raw inbound message for positive
                // sentiment morphemes. If score >= threshold AND tenant has a
                // review link AND this customer had >= 2 prior messages → schedule.
                if (tenant.reviewLink && messageText) {
                    const closureSignals = [
                        // Explicit thanks / satisfaction
                        /\b(thanks|thank you|shukriya|dhanyavad|dhanyabad|bahut shukriya|bahut dhanyavad)\b/i,
                        /\b(bahut accha|bahut badhiya|superb|excellent|perfect|best|zabardast)\b/i,
                        // Confirmation of receipt / completion
                        /\b(mil gaya|mil gyi|aa gaya|aa gyi|received|le liya|ho gaya|ho gyi|done|completed)\b/i,
                        /\b(theek hai|theek h|thik hai|sahi hai|bilkul sahi|sahi|ok bhai|okay bhai)\b/i,
                        // Positive goodbye
                        /\b(bye|alvida|phir milenge|phir aaunga|zaroor aaunga|aata rahunga)\b/i,
                        // Satisfaction emoji clusters
                        /[👍✅🙏😊🤝❤️]{1,}/u,
                    ];

                    const closureScore = closureSignals.filter(rx => rx.test(messageText)).length;
                    const isPositiveClosure = closureScore >= 1;

                    // Only trigger if this is a real engaged customer (not first message)
                    const priorMsgCount = history.filter(m => m.role === 'user').length;
                    const isEngaged = priorMsgCount >= 2;

                    if (isPositiveClosure && isEngaged) {
                        console.log(`⭐ Closure detected (score=${closureScore}) for ${senderNumber} — scheduling review`);
                        reviewService.scheduleReview(tenant.id, pushName, senderNumber, false).catch(() => { });
                    }
                }

                // Secondary: AI tag fallback (catches longer positive closings the regex misses)
                if (shouldScheduleReview && tenant.reviewLink) {
                    console.log(`⭐ AI tag triggered review for ${senderNumber}`);
                    reviewService.scheduleReview(tenant.id, pushName, senderNumber, false).catch(() => { });
                }

                console.log(`✅ Batched conversation handled on ${tenant.name} | Active chats: ${conversationService.getActiveCount()} | Products: ${productService.getCount(tenant.id)}`);

            } catch (err) {
                let safeErr = 'Unknown';
                if (err?.response?.data) safeErr = JSON.stringify(err.response.data);
                else {
                    let info = [];
                    if (err?.message) info.push(`MSG: ${err.message}`);
                    if (err?.name) info.push(`NAME: ${err.name}`);
                    if (info.length === 0) { try { safeErr = JSON.stringify(err, Object.getOwnPropertyNames(err)).substring(0,200); } catch(e){} }
                    else safeErr = info.join(' | ');
                }
                console.error(`❌ Batch processing error for ${senderNumber}: ${safeErr}`);
            }
        }, BATCH_DELAY_MS);

    } catch (error) {
        console.error('❌ Webhook processing error:', error.message);
        if (!res.headersSent) {
            return res.status(200).json({ status: 'error', message: error.message });
        }
    }
});

module.exports = router;