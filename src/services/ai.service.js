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
     * Classify intent using a zero-cost linguistic rule engine.
     *
     * Design principles — no keyword lists, no API calls:
     *
     * 1. STRUCTURAL signals: message length, punctuation, script mix,
     *    emoji density, question marks. These generalise across all
     *    languages and dialects without listing specific words.
     *
     * 2. SCRIPT detection: Devanagari-only messages with no question mark
     *    and no price signal are almost always greetings or casual — not
     *    business inquiries. Latin-script short messages with no question
     *    mark trend casual. Mixed script with a question mark trends business.
     *
     * 3. SEMANTIC signals derived from character-level patterns rather than
     *    words: currency symbols (₹, Rs), digit sequences (prices, quantities),
     *    forward-slash patterns (specifications like "4MP/30m"), question marks.
     *    These are language-agnostic.
     *
     * 4. IMAGE context: if the message starts with [CUSTOMER SENT AN IMAGE],
     *    it was already classified by classifyImageContext() in the webhook —
     *    extract that type and map it directly to an intent.
     *
     * Returns synchronously — zero latency, zero API cost.
     * @param {Object} tenant
     * @param {string} message
     * @returns {string} One of this.intents
     */
    detectIntent(tenant, message) {
        if (!message || message.trim().length === 0) return this.intents.BUSINESS_INQUIRY;

        const raw = message.trim();
        const lower = raw.toLowerCase();

        // ── 1. IMAGE CONTEXT: already classified upstream ──────────────────────
        // The webhook injects [CUSTOMER SENT AN IMAGE — ...TYPE...] into history.
        // Extract the type and map directly — no further analysis needed.
        if (raw.startsWith('[CUSTOMER SENT AN IMAGE')) {
            if (lower.includes('festival') || lower.includes('religious') || lower.includes('greeting image'))
                return this.intents.GREETING;
            if (lower.includes('payment') || lower.includes('invoice') || lower.includes('bill'))
                return this.intents.BUSINESS_INQUIRY;
            if (lower.includes('product image') || lower.includes('product'))
                return this.intents.BUSINESS_INQUIRY;
            return this.intents.BUSINESS_INQUIRY; // default for other image types
        }

        // ── 2. SCRIPT ANALYSIS ─────────────────────────────────────────────────
        const devanagariChars = (raw.match(/[\u0900-\u097F]/g) || []).length;
        const latinChars = (raw.match(/[a-zA-Z]/g) || []).length;
        const digitChars = (raw.match(/[0-9]/g) || []).length;
        const totalChars = raw.replace(/\s/g, '').length || 1;

        const devanagariRatio = devanagariChars / totalChars;
        const latinRatio = latinChars / totalChars;
        const isDevanagariHeavy = devanagariRatio > 0.5;
        const isMixedScript = devanagariRatio > 0.1 && latinRatio > 0.1;

        // ── 3. STRUCTURAL SIGNALS ──────────────────────────────────────────────
        const wordCount = raw.split(/\s+/).filter(Boolean).length;
        const hasQuestion = raw.includes('?');
        const emojiCount = (raw.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
        const emojiRatio = emojiCount / Math.max(wordCount, 1);

        // ── 4. SEMANTIC CHARACTER PATTERNS (language-agnostic) ────────────────
        // Price signal: ₹ or "Rs" or a digit sequence ≥ 3 digits
        const hasPriceSignal = /₹|\brs\b|\brupe|\d{3,}/.test(lower);
        // Specification signal: digit+unit patterns like "4MP", "2TB", "100m", "1kW"
        const hasSpecSignal = /\d+\s*(mp|tb|gb|mb|kw|kwh|kva|watt|volt|amp|meter|feet|inch|km|mb\/s)/.test(lower);
        // Contact/action signal: forward-slash (model numbers), @ symbol, URLs
        const hasRefSignal = /\/|@|https?:\/\/|www\./.test(raw);
        // Salutation pattern: message starts with a single word ≤8 chars, possibly followed by punctuation
        const startsLikeSalutation = /^[\w\u0900-\u097F]{1,8}[!?.\s]*$/.test(raw);

        // ── 5. SCORING ────────────────────────────────────────────────────────
        // Assign weighted scores for BUSINESS and CASUAL signals.
        // Whichever wins determines the intent.

        let businessScore = 0;
        let casualScore = 0;

        // Business signals
        if (hasQuestion) businessScore += 3;  // Questions are almost always business
        if (hasPriceSignal) businessScore += 4;  // Prices = definitely business
        if (hasSpecSignal) businessScore += 3;  // Specs = product inquiry
        if (hasRefSignal) businessScore += 2;  // Model numbers, links
        if (wordCount > 8) businessScore += 2;  // Long messages trend business
        if (isMixedScript) businessScore += 1;  // Hinglish tends toward business
        if (digitChars > 3) businessScore += 2;  // Numbers = prices, quantities

        // Casual / greeting signals
        if (wordCount <= 3) casualScore += 3;  // Very short = casual
        if (emojiRatio > 0.3) casualScore += 2;  // Emoji-heavy = social
        if (startsLikeSalutation) casualScore += 3;  // Single-word opener = greeting
        if (isDevanagariHeavy && !hasQuestion && wordCount <= 6) casualScore += 2;
        if (wordCount <= 1) casualScore += 2;  // Single word is almost always casual

        // ── 6. DECISION ───────────────────────────────────────────────────────
        console.log(`🧠 Intent signals — business:${businessScore} casual:${casualScore} words:${wordCount} q:${hasQuestion} price:${hasPriceSignal}`);

        // Strong business signals override everything
        if (hasPriceSignal || hasSpecSignal) return this.intents.BUSINESS_INQUIRY;

        if (casualScore > businessScore) {
            // Distinguish GREETING (no prior context expected) from CASUAL_REPLY
            // (acknowledging something). Greeting = opener words or emoji-only.
            if (startsLikeSalutation || emojiRatio > 0.5 || wordCount <= 1)
                return this.intents.GREETING;
            return this.intents.CASUAL_REPLY;
        }

        return this.intents.BUSINESS_INQUIRY;
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

    // ─────────────────────── Image description pipeline ──────────────
    //
    // Two-step approach to eliminate vision safety misfires:
    //
    // Step 1 — _describeImage(): Send the image to a vision model with a
    //   completely neutral, context-free prompt: "Describe what is in this
    //   image in one factual sentence." No user text, no business context.
    //   The model cannot misfire here — it sees only pixels and a benign
    //   describe instruction. Returns a plain English description.
    //
    // Step 2 — The description replaces imageData in the main AI call.
    //   The main model is now text-only. It reads the description alongside
    //   the conversation history and responds naturally. The vision safety
    //   classifier is never involved in the response step.
    //
    // Result: "Ye le liya h" + electric door lock photo →
    //   description: "An electric door lock product in packaging."
    //   Main AI reads that as text and responds appropriately.

    async describeImage(imageData) {
        // Neutral describe prompt — no business context, no user message.
        // Deliberately minimal so the vision safety filter has nothing to
        // pattern-match against.
        const DESCRIBE_PROMPT = 'Describe what is in this image in one factual sentence. Be objective and brief.';

        // Try NVIDIA vision first
        if (this.nvidiaClient) {
            try {
                const completion = await this.nvidiaClient.chat.completions.create({
                    model: this.nvidiaVisionModel,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: DESCRIBE_PROMPT },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData}` } },
                        ],
                    }],
                    temperature: 0.1,
                    max_tokens: 80,
                });
                const desc = completion.choices[0]?.message?.content?.trim();
                if (desc) {
                    console.log(`🖼️  [NVIDIA] Image described: "${desc}"`);
                    return desc;
                }
            } catch (err) {
                console.error('❌ [NVIDIA] _describeImage failed:', err.message);
            }
        }

        // Fallback: Gemini vision
        if (this.geminiAI) {
            try {
                const model = this.geminiAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
                const result = await model.generateContent([
                    DESCRIBE_PROMPT,
                    { inlineData: { mimeType: 'image/jpeg', data: imageData } },
                ]);
                const desc = result.response.text()?.trim();
                if (desc) {
                    console.log(`🖼️  [Gemini] Image described: "${desc}"`);
                    return desc;
                }
            } catch (err) {
                console.error('❌ [Gemini] _describeImage failed:', err.message);
            }
        }

        return null; // Both failed — caller handles gracefully
    }

    // NVIDIA text (unchanged)
    async _nvidiaVision(systemPrompt, conversationHistory, imageData) {
        // This method is now only called after imageData has been replaced
        // with a text description — see generateResponse(). It runs as a
        // normal text call with the description injected into history.
        return this._nvidiaText(systemPrompt, conversationHistory);
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
        // Images no longer reach the response model (two-step pipeline),
        // so vision safety misfires are structurally impossible.
        // This method only does formatting cleanup.
        return text
            .replace(/\*\*(.*?)\*\*/g, '*$1*') // Convert **bold** to *bold*
            .replace(/\n{3,}/g, '\n\n')          // Normalize 3+ newlines to 2
            .trim();
    }

    // ═══════════════════ main entry point ═════════════════════════

    async generateResponse(tenant, conversationHistory, imageData = null, intent = null) {
        if (!this.nvidiaClient && !this.geminiAI) {
            return "I'm sorry, the AI service is not configured yet. Please contact the administrator.";
        }

        // Image description is handled upstream in the webhook (before this is called).
        // The webhook calls describeImage(), amends conversation history with the result,
        // then passes null for imageData here. So the main AI is always text-only —
        // the vision safety classifier never fires, and intent detection has real content.
        const systemPrompt = await this.buildSystemPrompt(tenant, intent);
        const response = await this._generateWithProviders(systemPrompt, conversationHistory, false, null);

        if (response) {
            return this._postProcessResponse(response);
        }

        return "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";
    }
}

module.exports = new AIService();