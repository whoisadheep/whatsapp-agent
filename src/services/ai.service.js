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
8. CRITICAL: Tags like [SEND_UPI_QR] and [SEND_LEAD_SUMMARY] must be written EXACTLY as shown, with square brackets and NO asterisks or additional formatting.
---
`;

        // FIX: Added image and social message handling instructions.
        // Previously the AI had no guidance for images or non-business messages,
        // causing payment screenshots to get a refusal and social messages to get
        // a cold sales deflection.
        const IMAGE_HANDLING_RULES = `
---
IMAGE HANDLING RULES:
When the customer sends an image, the message will start with [CUSTOMER SENT AN IMAGE ...].
- If it is a PAYMENT_SCREENSHOT: Acknowledge the payment warmly. Thank the customer. 
  Ask what product/service the payment is for if unclear. NEVER say you cannot help with this.
  Example: "Thank you for the payment! ✅ Could you let us know which product or service this payment is for so we can process it?"
- If it is a PRODUCT_IMAGE or PRODUCT_QUERY_IMAGE: Describe what you see and help with their query.
- If it is an INVOICE_OR_BILL: Help the customer with their billing query.
- If image download failed (noted in the context): Respond warmly based on the caption/type context provided. Never say "I'm not able to provide help with this conversation."
- NEVER respond with "I'm not able to provide help with this conversation" for any image type.
---
`;

        const SOCIAL_MESSAGE_RULES = `
---
SOCIAL & NON-BUSINESS MESSAGE RULES:
People sometimes send greetings, religious messages, good morning/night wishes, or general chit-chat.
Handle these gracefully WITHOUT a cold business deflection:
- For greetings (hi, hello, good morning, good night, namaste): Respond warmly and briefly, then offer help. 
  Do NOT say "Sorry, I can only help with [product]..." for a simple greeting.
- For religious/devotional forwards (shlokas, prayers, quotes): Acknowledge respectfully with a one-line warm reply (e.g., "Jai Shiv Shambhu! 🙏 Koi madad chahiye to batayein."). 
  Do NOT follow with a sales pitch.
- For "how are you" or personal chat: Respond briefly and warmly, then gently steer toward business.
- Only deflect to "main sirf X mein help kar sakta hoon" if the person is asking about something completely unrelated AND is clearly expecting a business-type answer.
The goal: never make a person feel like they messaged a cold robot when they were just being friendly.
---
`;

        return tenant.systemPrompt + catalogText + CHANNEL_FORMATTING_RULES + IMAGE_HANDLING_RULES + SOCIAL_MESSAGE_RULES;
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
        const userContent = [
            {
                type: 'text',
                text: lastMsg.content || 'What is in this image?',
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

        const parts = [
            { text: lastMessage.parts[0].text || 'What is in this image?' },
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