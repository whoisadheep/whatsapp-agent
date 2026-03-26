const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const productService = require('./product.service');

class AIService {
    constructor() {
        // ── NVIDIA (Primary) ──
        this.nvidiaKey = process.env.NVIDIA_API_KEY;
        this.nvidiaBaseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
        this.nvidiaTextModel = process.env.NVIDIA_MODEL_NAME || 'meta/llama-3.1-405b-instruct';
        this.nvidiaVisionModel = process.env.NVIDIA_VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';

        if (this.nvidiaKey) {
            this.nvidiaClient = new OpenAI({
                apiKey: this.nvidiaKey,
                baseURL: this.nvidiaBaseUrl,
            });
            console.log('✅ NVIDIA NIM client initialised (primary)');
        } else {
            this.nvidiaClient = null;
            console.warn('⚠️  NVIDIA_API_KEY not set – NVIDIA provider disabled.');
        }

        // ── Gemini (Fallback) ──
        this.geminiKey = process.env.GEMINI_API_KEY;
        if (this.geminiKey) {
            this.geminiAI = new GoogleGenerativeAI(this.geminiKey);
            console.log('✅ Google Gemini client initialised (fallback)');
        } else {
            this.geminiAI = null;
            console.warn('⚠️  GEMINI_API_KEY not set – Gemini fallback disabled.');
        }

        if (!this.nvidiaClient && !this.geminiAI) {
            console.error('❌ No AI provider configured! AI responses will not work.');
        }
    }

    // ─────────────────────────── helpers ───────────────────────────

    async buildSystemPrompt(tenant) {
        if (!tenant || !tenant.systemPrompt) {
            return 'You are a helpful business assistant.';
        }
        const catalogText = await productService.getCatalogText(tenant.id);

        const CHANNEL_FORMATTING_RULES = `
---
CRITICAL WHATSAPP FORMATTING RULES:
1. Use *bold* for bold text (NEVER use **bold**).
2. Use _italics_ for emphasis.
3. Use bullet points (• or -) for lists.
4. Keep paragraphs short and use exactly 2 newlines (one empty line) between them for readability.
5. NEVER use more than 2 consecutive newlines.
6. Use emojis sparingly to maintain a professional yet warm tone.
7. If providing a list of products/prices, use a clear "Property: Value" format on new lines.
8. CRITICAL: Tags like [SEND_UPI_QR], [SEND_LEAD_SUMMARY], and [SCHEDULE_REVIEW] must be written EXACTLY as shown, with square brackets and NO asterisks or additional formatting.
---
`;

        const REVIEW_TRIGGER_RULES = `
---
GOOGLE REVIEW — AUTO-TRIGGER RULES:
After your reply, append the tag [SCHEDULE_REVIEW] (invisible to customer, caught by the system)
when ALL of the following are true:
1. The conversation has reached a natural positive close — customer said thank you, confirmed receipt, said goodbye, expressed satisfaction, or confirmed a purchase/booking.
2. The customer's sentiment is clearly positive or neutral-positive.
3. The business has a review link configured.

TRIGGER examples (append [SCHEDULE_REVIEW]):
- Customer says: "ok bhai mil gaya", "thanks", "theek hai", "done", "received", "perfect", "bahut accha"
- Customer confirmed a payment or purchase was completed

DO NOT TRIGGER examples (do NOT append [SCHEDULE_REVIEW]):
- Customer is still asking questions or negotiating
- Customer expressed frustration, complaint, or dissatisfaction

Only append [SCHEDULE_REVIEW] ONCE per conversation closing.
---
`;

        // ─── FIX 1: Tighter Image Rules (No Wikipedia essays) ───
        const IMAGE_HANDLING_RULES = `
---
IMAGE HANDLING RULES:
When the customer sends an image:
- PAYMENT_SCREENSHOT: Warmly thank them. Ask what product/service it's for. NEVER say you cannot help.
- PRODUCT_IMAGE (or forwarded product): DO NOT write a long essay or list specifications. Keep it to 1-2 lines. Acknowledge the product briefly and ask a short clarifying question like "Yeh product chahiye aapko?"
- GENERAL/FESTIVAL IMAGE: If it's a greeting, reply warmly with a relevant wish.
- NEVER respond with "I'm not able to provide help with this conversation."
---
`;

        // ─── FIX 2: Social Links & Patience Rules ───
        const SOCIAL_MESSAGE_RULES = `
---
SOCIAL, LINKS & DELAYED RESPONSES:
- URLs/LINKS: If a user sends a YouTube link or URL with no context, DO NOT pitch products. Simply ask: "Aap iske baare mein kya jaanna chahte hain?"
- PATIENCE ("Bataunga"): If a customer says they will tell you later (e.g., "bataunga", "baad mein batata hoon"), reply with a short, polite acknowledgement like "Ji zaroor, jab zaroorat ho batayen 🙏" and DO NOT ask any follow-up questions.
- GREETINGS/RELIGIOUS: Respond briefly and warmly (e.g., "Jai Shiv Shambhu! 🙏"). Do NOT immediately push a sales pitch.
---
`;

        // ─── FIX 3: Anti-Hallucination Rules ───
        const ANTI_HALLUCINATION_RULES = `
---
STRICT INVENTORY & SCOPE RULES:
- NEVER claim to sell products or services that are not explicitly listed in your catalog or scope. 
- If a customer asks about a product you do not sell (e.g., Interactive Panels), honestly state that you do not sell it, and politely mention what you DO specialize in. Do not invent "similar ranges."
---
`;

        return tenant.systemPrompt + catalogText + CHANNEL_FORMATTING_RULES + REVIEW_TRIGGER_RULES + IMAGE_HANDLING_RULES + SOCIAL_MESSAGE_RULES + ANTI_HALLUCINATION_RULES;
    }

    // ─────────────────────── NVIDIA: text ─────────────────────────

    async _nvidiaText(systemPrompt, conversationHistory) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory.map((msg) => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content,
            })),
        ];

        const completion = await this.nvidiaClient.chat.completions.create({
            model: this.nvidiaTextModel,
            messages,
            temperature: 0.2,
            top_p: 0.7,
            max_tokens: 1024,
        });

        return completion.choices[0].message.content;
    }

    // ─────────────────────── NVIDIA: vision ───────────────────────

    async _nvidiaVision(systemPrompt, conversationHistory, imageData) {
        const historyMessages = conversationHistory.slice(0, -1).map((msg) => ({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
        }));

        const lastMsg = conversationHistory[conversationHistory.length - 1];

        // ─── FIX 4: Changed fallback prompt from 'What is in this image?' to something that respects rules ───
        const fallbackVisionText = "User sent an image. Please respond briefly in the correct language according to your SYSTEM rules.";

        const userContent = [
            {
                type: 'text',
                text: lastMsg.content && lastMsg.content !== '[SENT AN IMAGE] ' ? lastMsg.content : fallbackVisionText,
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${imageData}`,
                },
            },
        ];

        const messages = [
            { role: 'system', content: systemPrompt },
            ...historyMessages,
            { role: 'user', content: userContent },
        ];

        console.log(`📡 [NVIDIA] Sending vision request...`);
        const completion = await this.nvidiaClient.chat.completions.create({
            model: this.nvidiaVisionModel,
            messages,
            temperature: 0.1,
            top_p: 0.7,
            max_tokens: 2048,
        });

        console.log(`📡 [NVIDIA] Received response`);
        return completion.choices[0].message.content;
    }

    // ──────────────────────── Gemini: text ─────────────────────────

    async _geminiText(systemPrompt, conversationHistory) {
        const model = this.geminiAI.getGenerativeModel({
            model: 'gemini-2.0-flash-lite',
            systemInstruction: systemPrompt,
        });

        const contents = conversationHistory.map((msg) => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const chat = model.startChat({ history: contents.slice(0, -1) });
        const lastMessage = contents[contents.length - 1];
        const result = await chat.sendMessage([{ text: lastMessage.parts[0].text }]);
        return result.response.text();
    }

    // ──────────────────────── Gemini: vision ──────────────────────

    async _geminiVision(systemPrompt, conversationHistory, imageData) {
        const model = this.geminiAI.getGenerativeModel({
            model: 'gemini-2.0-flash-lite',
            systemInstruction: systemPrompt,
        });

        const contents = conversationHistory.map((msg) => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const chat = model.startChat({ history: contents.slice(0, -1) });
        const lastMessage = contents[contents.length - 1];

        // ─── FIX 4 (Continued for Gemini) ───
        const fallbackVisionText = "User sent an image. Please respond briefly in the correct language according to your SYSTEM rules.";
        const textPart = lastMessage.parts[0].text && lastMessage.parts[0].text !== '[SENT AN IMAGE] '
            ? lastMessage.parts[0].text
            : fallbackVisionText;

        const parts = [
            { text: textPart },
            { inlineData: { mimeType: 'image/jpeg', data: imageData } },
        ];

        console.log(`📡 [Gemini] Sending vision request...`);
        const result = await chat.sendMessage(parts);
        console.log(`📡 [Gemini] Received response`);
        return result.response.text();
    }

    // ═══════════════════ provider orchestration ═══════════════════

    async _generateWithProviders(systemPrompt, conversationHistory, hasImage, imageData) {
        const providers = [];

        if (this.nvidiaClient) {
            providers.push({
                name: 'NVIDIA',
                fn: hasImage
                    ? () => this._nvidiaVision(systemPrompt, conversationHistory, imageData)
                    : () => this._nvidiaText(systemPrompt, conversationHistory),
            });
        }

        if (this.geminiAI) {
            providers.push({
                name: 'Gemini',
                fn: hasImage
                    ? () => this._geminiVision(systemPrompt, conversationHistory, imageData)
                    : () => this._geminiText(systemPrompt, conversationHistory),
            });
        }

        for (const provider of providers) {
            try {
                console.log(`🔄 Trying provider: ${provider.name}...`);

                const timeoutMs = 15000;
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`${provider.name} timed out after ${timeoutMs}ms`)), timeoutMs)
                );

                const response = await Promise.race([provider.fn(), timeoutPromise]);

                if (response) {
                    console.log(`🤖 AI response generated via ${provider.name}${hasImage ? ' (vision)' : ''}`);
                    return response;
                }
                console.warn(`⚠️ ${provider.name} returned empty response`);
            } catch (error) {
                console.error(`❌ ${provider.name} failed: ${error.message}`);
                if (error.response?.data) {
                    console.error('API Error details:', JSON.stringify(error.response.data).slice(0, 500));
                }
            }
        }

        return null;
    }

    _postProcessResponse(text) {
        if (!text) return text;

        // ─── FIX 5: SAFETY REFUSAL OVERRIDE ───
        // Catch hardcoded model safety refusals triggered by festival/religious images
        const safetyStrings = [
            "I'm not able to provide help with this conversation",
            "I cannot fulfill this request",
            "I can't help with that",
            "I am unable to",
            "I cannot analyze this image",
            "I cannot fulfill that request"
        ];

        if (safetyStrings.some(s => text.includes(s))) {
            console.warn('⚠️ AI triggered a vision safety refusal. Overriding with generic warm response.');
            return "Message received! 👍 Main aapki kaise madad kar sakta hoon?";
        }

        return text
            .replace(/\*\*(.*?)\*\*/g, '*$1*') // Convert **bold** to *bold*
            .replace(/\n{3,}/g, '\n\n')         // Normalize 3+ newlines to 2
            .trim();
    }

    // ═══════════════════ main entry point ═════════════════════════

    async generateResponse(tenant, conversationHistory, imageData = null) {
        if (!this.nvidiaClient && !this.geminiAI) {
            return "I'm sorry, the AI service is not configured yet. Please contact the administrator.";
        }

        const hasImage = Boolean(imageData);
        const systemPrompt = await this.buildSystemPrompt(tenant);
        const response = await this._generateWithProviders(systemPrompt, conversationHistory, hasImage, imageData);

        if (response) {
            return this._postProcessResponse(response);
        }

        return "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";
    }
}

module.exports = new AIService();