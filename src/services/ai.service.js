const { GoogleGenerativeAI } = require('@google/generative-ai');
const productService = require('./product.service');

class AIService {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;

        if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
            console.warn('⚠️  GEMINI_API_KEY is not set. AI responses will not work.');
            this.client = null;
            return;
        }

        this.genAI = new GoogleGenerativeAI(this.apiKey);
    }

    /**
     * Build the full system prompt with product catalog appended for the given tenant.
     */
    async buildSystemPrompt(tenant) {
        if (!tenant || !tenant.systemPrompt) {
            return 'You are a helpful business assistant.'; // safe fallback
        }

        const catalogText = await productService.getCatalogText(tenant.id);
        return tenant.systemPrompt + catalogText;
    }

    async generateResponse(tenant, conversationHistory) {
        if (!this.genAI) {
            return "I'm sorry, the AI service is not configured yet. Please contact the administrator.";
        }

        try {
            // Build system prompt with current product catalog for the specific tenant
            const systemPrompt = await this.buildSystemPrompt(tenant);

            const model = this.genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: systemPrompt,
            });

            // Convert conversation history to Gemini format
            const contents = conversationHistory.map((msg) => ({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }],
            }));

            const chat = model.startChat({
                history: contents.slice(0, -1),
            });

            // Send the latest user message
            const lastMessage = contents[contents.length - 1];
            const result = await chat.sendMessage(lastMessage.parts[0].text);
            const response = result.response.text();

            console.log('🤖 AI response generated successfully');
            return response;
        } catch (error) {
            console.error('❌ AI generation failed:', error.message);
            return "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";
        }
    }
}

module.exports = new AIService();
