const express = require('express');
const router = express.Router();
const db = require('../services/db.service');
const tenantService = require('../services/tenant.service');
const evolutionService = require('../services/evolution.service');
const takeoverService = require('../services/takeover.service');
const conversationService = require('../services/conversation.service');
const { requireAuth } = require('../middleware/auth.middleware');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// GET /api/tenants - List all tenants for authenticated user
router.get('/tenants', requireAuth, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM tenants WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching tenants:', error);
        res.status(500).json({ error: 'Failed to fetch tenants', details: error.message });
    }
});

// GET /api/tenants/:id - Get a specific tenant
router.get('/tenants/:id', requireAuth, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM tenants WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching tenant:', error);
        res.status(500).json({ error: 'Failed to fetch tenant' });
    }
});

// POST /api/tenants - Create a new business and provision WhatsApp instance
router.post('/tenants', requireAuth, async (req, res) => {
    try {
        const { name, instance_name, owner_phone, system_prompt } = req.body;
        const user_id = req.user.id;

        if (!name || !instance_name) {
            return res.status(400).json({ error: 'Business name and instance name are required' });
        }

        // Generate a URL-safe ID from the name
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

        // Check if tenant already exists
        const exists = await db.query('SELECT id FROM tenants WHERE id = $1', [id]);
        if (exists && exists.rows.length > 0) {
            return res.status(409).json({ error: 'A business with this name already exists' });
        }

        // Default receptionist prompt if none provided
        const defaultPrompt = `You are an AI receptionist for ${name}. 
You greet customers, answer basic questions, and collect their name and inquiry.

*CRITICAL BOUNDARY RULE (ACT AS RECEPTIONIST):*
- You ONLY know the information explicitly written in this prompt.
- If a customer asks a complex question, technical detail, or anything you are unsure about, DO NOT GUESS OR INVENT.
- Immediately reply politely that you are notifying the owner and append the tag [HANDOFF].

*THE SILENCE RULE (AVOID ENDLESS LOOPS):*
- If the customer sends a simple acknowledgment or emoji (e.g., "Thanks", "Ok", "👍") AND they do not ask a new question, DO NOT REPLY.
- Output ONLY the exact tag [SILENCE].`;

        // 1. Insert into database
        const result = await db.query(
            `INSERT INTO tenants 
            (id, user_id, name, instance_name, system_prompt, owner_phone, takeover_timeout_ms) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [id, user_id, name, instance_name, system_prompt || defaultPrompt, owner_phone || null, 1800000]
        );

        const tenant = result.rows[0];
        console.log(`✅ New tenant created: ${name} (${id})`);

        // 2. Create Evolution API instance
        let qrData = null;
        try {
            await evolutionService.createInstance(instance_name);

            // 3. Set webhook
            const port = process.env.PORT || 3001;
            const webhookUrl = process.env.WEBHOOK_URL
                || (process.env.DOCKER_ENV === 'true'
                    ? `http://whatsapp-agent:${port}/webhook`
                    : `http://localhost:${port}/webhook`);
            await evolutionService.setWebhook(instance_name, webhookUrl);

            // 4. Get QR code
            qrData = await evolutionService.getQrCode(instance_name);
            console.log(`📱 QR code generated for ${instance_name}`);
        } catch (evoError) {
            console.error(`⚠️ Evolution API setup failed for ${instance_name}:`, evoError.message);
            // We still return the tenant — QR can be fetched later
        }

        // 5. Reload tenant cache
        await tenantService.loadFromDb();

        res.status(201).json({ 
            tenant, 
            qr: qrData,
            message: 'Business created successfully!' 
        });
    } catch (error) {
        console.error('Error creating tenant:', error);
        res.status(500).json({ error: 'Failed to create business' });
    }
});

// GET /api/tenants/:id/qr - Get QR code for a tenant's WhatsApp instance
router.get('/tenants/:id/qr', requireAuth, async (req, res) => {
    try {
        const result = await db.query('SELECT instance_name FROM tenants WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant not found' });
        }

        const qrData = await evolutionService.getQrCode(result.rows[0].instance_name);
        res.json(qrData);
    } catch (error) {
        console.error('Error fetching QR:', error);
        res.status(500).json({ error: 'Failed to fetch QR code' });
    }
});

// GET /api/tenants/:id/status - Get connection status of a tenant's WhatsApp
router.get('/tenants/:id/status', requireAuth, async (req, res) => {
    try {
        const result = await db.query('SELECT instance_name FROM tenants WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant not found' });
        }

        const status = await evolutionService.getInstanceStatus(result.rows[0].instance_name);
        res.json(status);
    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// GET /api/tenants/:id/analytics - Get metrics for the dashboard
router.get('/tenants/:id/analytics', requireAuth, async (req, res) => {
    try {
        const tenantId = req.params.id;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [tenantId, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });

        // Fetch Total Customers
        const customersResult = await db.query('SELECT COUNT(*) FROM customers WHERE tenant_id = $1', [tenantId]);
        const totalCustomers = parseInt(customersResult?.rows[0]?.count || 0, 10);

        // Fetch AI Messages
        const aiMessagesResult = await db.query("SELECT COUNT(*) FROM messages WHERE tenant_id = $1 AND role = 'assistant'", [tenantId]);
        const aiMessages = parseInt(aiMessagesResult?.rows[0]?.count || 0, 10);

        // Fetch Handoffs
        const handoffsResult = await db.query('SELECT COUNT(*) FROM takeover_state WHERE tenant_id = $1', [tenantId]);
        const handoffs = parseInt(handoffsResult?.rows[0]?.count || 0, 10);

        // Calculate Time Saved (1.5 minutes per AI message)
        const timeSavedMinutes = aiMessages * 1.5;
        let timeSavedStr = `${timeSavedMinutes.toFixed(1)} mins`;
        if (timeSavedMinutes >= 60) {
            timeSavedStr = `${(timeSavedMinutes / 60).toFixed(1)} hrs`;
        }

        res.json({
            totalCustomers,
            aiMessages,
            handoffs,
            timeSaved: timeSavedStr
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});


// PUT /api/tenants/:id - Update a tenant's settings
router.put('/tenants/:id', requireAuth, async (req, res) => {
    try {
        const { 
            name, instance_name, system_prompt, ignored_numbers, 
            allowed_groups, takeover_timeout_ms, owner_phone 
        } = req.body;

        const result = await db.query(
            `UPDATE tenants 
             SET name = $1, instance_name = $2, system_prompt = $3, 
                 ignored_numbers = $4, allowed_groups = $5, 
                 takeover_timeout_ms = $6, owner_phone = $7,
                 updated_at = NOW()
             WHERE id = $8 AND user_id = $9 RETURNING *`,
            [
                name, 
                instance_name, 
                system_prompt, 
                ignored_numbers, 
                allowed_groups, 
                takeover_timeout_ms, 
                owner_phone, 
                req.params.id,
                req.user.id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant not found' });
        }

        // Reload the tenantService cache so the changes apply instantly without restarting the server!
        await tenantService.loadFromDb();

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating tenant:', error);
        res.status(500).json({ error: 'Failed to update tenant' });
    }
});

// DELETE /api/tenants/:id - Delete a tenant
router.delete('/tenants/:id', requireAuth, async (req, res) => {
    try {
        const tenantId = req.params.id;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [tenantId, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        
        // Delete all related records manually to avoid foreign key errors if cascade isn't on
        await db.query('DELETE FROM knowledge_documents WHERE tenant_id = $1', [tenantId]);
        await db.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
        await db.query('DELETE FROM takeover_state WHERE tenant_id = $1', [tenantId]);
        await db.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
        
        // Delete the tenant
        const result = await db.query('DELETE FROM tenants WHERE id = $1 RETURNING *', [tenantId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tenant not found' });
        }
        
        await tenantService.loadFromDb();
        res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
        console.error('Error deleting tenant:', error);
        res.status(500).json({ error: 'Failed to delete tenant' });
    }
});

// POST /api/generate-prompt - AI generates a system prompt from business description
router.post('/generate-prompt', async (req, res) => {
    try {
        const { businessName, businessDescription, aiRole, language, extraContext } = req.body;

        if (!businessName || !businessDescription) {
            return res.status(400).json({ error: 'Business name and description are required' });
        }

        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) {
            return res.status(500).json({ error: 'AI service not configured' });
        }

        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite' });

        const metaPrompt = `You are an expert AI prompt engineer for WhatsApp AI receptionists. Your job is to create the BEST possible system prompt for a business's WhatsApp AI assistant.

The business owner has provided the following information:
- Business Name: ${businessName}
- What they do: ${businessDescription}
- What they want the AI to do: ${aiRole || 'Act as a receptionist, answer basic questions, and connect complex queries to the owner.'}
- Preferred language: ${language || 'Match whatever language the customer uses (Hindi, English, or Hinglish)'}
${extraContext ? `- Specific Details to memorize:\n${extraContext}\n` : ''}

Generate a complete, professional system prompt. The prompt MUST include these EXACT rules:

1. RECEPTIONIST BOUNDARY RULE: The AI must NEVER guess, invent, or hallucinate information not explicitly written in the prompt. If unsure, it must politely say it's notifying the owner and append the exact tag [HANDOFF] at the end of its message.

2. THE SILENCE RULE: If the customer sends a simple acknowledgment or emoji ("Thanks", "Ok", "👍") AND does NOT ask a new question, the AI must NOT reply. It must output ONLY the exact tag [SILENCE].

3. Include specific business details from the description (services, products, pricing if mentioned, location if mentioned).

4. Set the tone and personality based on the business type (formal for legal/medical, friendly for retail, etc.).

5. Use WhatsApp formatting: *bold* for emphasis (NOT **bold**), keep messages concise, use emojis sparingly.

IMPORTANT: Output ONLY the system prompt text. No explanations, no markdown fences, no meta-commentary. Start directly with "You are the AI assistant for..."`;

        const result = await model.generateContent(metaPrompt);
        const generatedPrompt = result.response.text().trim();

        console.log(`🧠 Generated system prompt for "${businessName}" (${generatedPrompt.length} chars)`);

        res.json({ prompt: generatedPrompt });
    } catch (error) {
        console.error('Error generating prompt:', error);
        res.status(500).json({ error: 'Failed to generate prompt' });
    }
});

// ─── LIVE INBOX ENDPOINTS ─────────────────────────────────────────────

// GET /api/tenants/:id/customers - List all customers for the inbox
router.get('/tenants/:id/customers', requireAuth, async (req, res) => {
    try {
        const tenantId = req.params.id;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [tenantId, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        
        const result = await db.query(`
            SELECT c.*, t.paused_at, t.timeout_ms 
            FROM customers c
            LEFT JOIN takeover_state t ON c.tenant_id = t.tenant_id AND c.phone = t.phone
            WHERE c.tenant_id = $1 
            ORDER BY c.last_seen DESC
        `, [tenantId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customers:', error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// GET /api/tenants/:id/customers/:phone/messages - Get chat history
router.get('/tenants/:id/customers/:phone/messages', requireAuth, async (req, res) => {
    try {
        const { id, phone } = req.params;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });

        const result = await db.query(
            'SELECT * FROM messages WHERE tenant_id = $1 AND phone = $2 ORDER BY created_at ASC',
            [id, phone]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// POST /api/tenants/:id/customers/:phone/takeover - Pause/Resume AI
router.post('/tenants/:id/customers/:phone/takeover', requireAuth, async (req, res) => {
    try {
        const { id, phone } = req.params;
        const { action } = req.body; // 'pause' or 'resume'

        const tenantResult = await db.query('SELECT * FROM tenants WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (!tenantResult || tenantResult.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        const tenant = tenantResult.rows[0];

        if (action === 'pause') {
            takeoverService.pause(tenant, phone, null); // pause indefinitely from UI
        } else if (action === 'resume') {
            takeoverService.resume(tenant.id, phone);
        } else {
            return res.status(400).json({ error: 'Invalid action. Must be pause or resume.' });
        }

        res.json({ success: true, action });
    } catch (error) {
        console.error('Error toggling takeover:', error);
        res.status(500).json({ error: 'Failed to toggle takeover' });
    }
});

// POST /api/tenants/:id/customers/:phone/send - Send manual message from owner
router.post('/tenants/:id/customers/:phone/send', requireAuth, async (req, res) => {
    try {
        const { id, phone } = req.params;
        const { text } = req.body;

        if (!text) return res.status(400).json({ error: 'Text is required' });

        const tenantResult = await db.query('SELECT * FROM tenants WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (!tenantResult || tenantResult.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        const tenant = tenantResult.rows[0];

        // 1. Send via WhatsApp
        await evolutionService.sendText(tenant.instance_name, phone, text);

        // 2. Log in DB as 'owner'
        await conversationService.addMessage(id, phone, 'owner', text);

        // 3. Auto-pause the AI so it doesn't double-reply
        takeoverService.pause(tenant, phone, null);

        res.json({ success: true, message: 'Sent successfully' });
    } catch (error) {
        console.error('Error sending manual message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});
// ─── KNOWLEDGE BASE ENDPOINTS ─────────────────────────────────────────

// GET /api/tenants/:id/knowledge - List documents
router.get('/tenants/:id/knowledge', requireAuth, async (req, res) => {
    try {
        const tenantId = req.params.id;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [tenantId, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        
        const result = await db.query('SELECT id, filename, created_at FROM knowledge_documents WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching knowledge:', error);
        res.status(500).json({ error: 'Failed to fetch knowledge docs' });
    }
});

// POST /api/tenants/:id/knowledge - Upload document
router.post('/tenants/:id/knowledge', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const tenantId = req.params.id;
        
        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [tenantId, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
        
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        let content = '';
        if (file.mimetype === 'application/pdf') {
            const data = await pdfParse(file.buffer);
            content = data.text;
        } else if (file.mimetype === 'text/plain') {
            content = file.buffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: 'Unsupported file type. Only PDF and TXT allowed.' });
        }

        // basic cleanup of text
        content = content.replace(/\n+/g, '\n').trim();
        
        if (!content) return res.status(400).json({ error: 'Could not extract text from file' });

        const result = await db.query(
            'INSERT INTO knowledge_documents (tenant_id, filename, content) VALUES ($1, $2, $3) RETURNING id, filename, created_at',
            [tenantId, file.originalname, content]
        );

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error uploading knowledge:', error);
        res.status(500).json({ error: 'Failed to upload document' });
    }
});

// DELETE /api/tenants/:id/knowledge/:docId
router.delete('/tenants/:id/knowledge/:docId', requireAuth, async (req, res) => {
    try {
        const { id, docId } = req.params;

        // Verify ownership
        const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (tenantCheck.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });

        const result = await db.query('DELETE FROM knowledge_documents WHERE tenant_id = $1 AND id = $2', [id, docId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting knowledge:', error);
        res.status(500).json({ error: 'Failed to delete document' });
    }
});

module.exports = router;
