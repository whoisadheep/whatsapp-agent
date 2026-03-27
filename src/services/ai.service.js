const OpenAI = require('openai');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
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

        // ─── Intent Categories ───
        this.intents = {
            GREETING: 'GREETING',           // "Hi", "Hello", "Good morning", festival wishes
            CASUAL_REPLY: 'CASUAL_REPLY',   // "Ok", "Thanks", "Theek hai", "Same to you"
            BUSINESS_INQUIRY: 'BUSINESS_INQUIRY', // Price, service, product, order
            DEALER_DISCUSSION: 'DEALER_DISCUSSION', // Dealer asking for payment/ledger
            PERSONAL_UNRELATED: 'PERSONAL_UNRELATED' // Family talk, random things
        };
    }

    // ─────────────────────────── helpers ───────────────────────────

    async buildSystemPrompt(tenant, intent = null) {
        if (!tenant || !tenant.systemPrompt) {
            return 'You are a helpful business assistant.';
        }
        const catalogText = (intent === this.intents.BUSINESS_INQUIRY) ? await productService.getCatalogText(tenant.id) : '';

        const INTENT_GUIDANCE = intent ? `
---
DETECTED INTENT: ${intent}
${intent === this.intents.GREETING || intent === this.intents.CASUAL_REPLY ? 
'CRITICAL: The user is sending a greeting or casual acknowledging. DO NOT introduce yourself as an AI assistant. DO NOT provide business details. Reply briefly and warmly (e.g., "Dhanyavaad 🙏" or "Jai Shri Ram!").' : 
'The user is inquiring about business. You may introduce yourself as the AI assistant if appropriate.'}
---
` : '';

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

        return INTENT_GUIDANCE + tenant.systemPrompt + catalogText + CHANNEL_FORMATTING_RULES + REVIEW_TRIGGER_RULES + IMAGE_HANDLING_RULES + SOCIAL_MESSAGE_RULES + ANTI_HALLUCINATION_RULES;
    }

    /**
     * Detects the intent of an incoming message.
     * @param {Object} tenant The tenant object
     * @param {string} message Text of the message
     * @returns {Promise<string>} One of this.intents
     */
    async detectIntent(tenant, message) {
        if (!message) return this.intents.BUSINESS_INQUIRY;

        const intentPrompt = `
You are an intent classifier for a WhatsApp business agent.
Categorize the following incoming message into EXACTLY ONE of these categories:
- GREETING: "Hi", "Hello", "Good morning", festival wishes (Diwali, Holi, etc.), religious greetings (Jai Shri Ram, etc.)
- CASUAL_REPLY: "Ok", "Thanks", "Theek hai", "Same to you", "Got it", "Theek"
- BUSINESS_INQUIRY: Questions about products, pricing, services, availability, orders, location, or business hours.
- DEALER_DISCUSSION: Conversations about payments, ledgers, outstanding amounts, or dealer-to-business transactions.
- PERSONAL_UNRELATED: Anything else that is strictly personal, family-related, or completely unrelated to the business.

Message: "${message}"

Respond with ONLY the category name.
`;

        try {
            const result = await this._generateWithProviders(intentPrompt, [], false, null);
            const detected = (result || '').trim().toUpperCase();

            if (detected.includes('GREETING')) return this.intents.GREETING;
            if (detected.includes('CASUAL_REPLY')) return this.intents.CASUAL_REPLY;
            if (detected.includes('DEALER_DISCUSSION')) return this.intents.DEALER_DISCUSSION;
            if (detected.includes('PERSONAL_UNRELATED')) return this.intents.PERSONAL_UNRELATED;
            
            return this.intents.BUSINESS_INQUIRY; // Default
        } catch (err) {
            console.error('❌ Intent detection failed:', err.message);
            return this.intents.BUSINESS_INQUIRY;
        }
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
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ]
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
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ]
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
            "I cannot fulfill that request",
            "illegal or harmful activities",
            "non-consensual or exploitative",
            "towards children"
        ];

        if (safetyStrings.some(s => text.includes(s))) {
            console.warn('⚠️ AI triggered a vision safety refusal.');
            return "__SAFETY_REFUSAL__";
        }

        return text
            .replace(/\*\*(.*?)\*\*/g, '*$1*') // Convert **bold** to *bold*
            .replace(/\n{3,}/g, '\n\n')         // Normalize 3+ newlines to 2
            .trim();
    }

    // ═══════════════════ main entry point ═════════════════════════

    async generateResponse(tenant, conversationHistory, imageData = null, intent = null) {
        if (!this.nvidiaClient && !this.geminiAI) {
            return "I'm sorry, the AI service is not configured yet. Please contact the administrator.";
        }

        const hasImage = Boolean(imageData);
        const systemPrompt = await this.buildSystemPrompt(tenant, intent);
        const response = await this._generateWithProviders(systemPrompt, conversationHistory, hasImage, imageData);

        if (response) {
            const processed = this._postProcessResponse(response);

            if (processed === "__SAFETY_REFUSAL__") {
                if (hasImage) {
                    console.log("🔄 Safety refusal on vision. Checking for text context...");
                    
                    const lastMsg = conversationHistory[conversationHistory.length - 1];
                    const hasText = lastMsg && lastMsg.content && lastMsg.content !== '[SENT AN IMAGE] ' && lastMsg.content.trim().length > 3;

                    if (hasText) {
                        console.log(`📡 Retrying with text context: "${lastMsg.content}"`);
                        const textOnlyResponse = await this._generateWithProviders(systemPrompt, conversationHistory, false, null);
                        if (textOnlyResponse) {
                            return this._postProcessResponse(textOnlyResponse);
                        }
                    }

                    // No text or text-only failed
                    return "Aapne image toh bhej di, par main use theek se dekh nahi pa raha hoon. 🙏 Kya aap bata sakte hain ki aap is product ki price, availability ya kisi aur cheez ke baare mein jaanna chahte hain?";
                }
                
                // If it was just text and still refused (rare)
                return "Message received! 👍 Main aapki kaise madad kar sakta hoon?";
            }

            return processed;
        }

        return "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";
    }
}

module.exports = new AIService();