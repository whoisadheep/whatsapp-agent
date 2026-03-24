const { GoogleGenerativeAI } = require('@google/generative-ai');

class TranscriptionService {
    constructor() {
        this.geminiKey = process.env.GEMINI_API_KEY;

        if (this.geminiKey) {
            this.genAI = new GoogleGenerativeAI(this.geminiKey);
            console.log('🎙️  Transcription service ready (Gemini)');
        } else {
            this.genAI = null;
            console.warn('⚠️  GEMINI_API_KEY not set — voice transcription disabled.');
        }
    }

    /**
     * Transcribe audio (base64) to text using Gemini.
     * @param {string} base64Audio - Base64 encoded audio data
     * @param {string} mimeType - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
     * @returns {string|null} Transcribed text, or null on failure
     */
    async transcribe(base64Audio, mimeType = 'audio/ogg') {
        if (!this.genAI) {
            console.error('❌ Transcription service not configured');
            return null;
        }

        try {
            const model = this.genAI.getGenerativeModel({
                model: 'gemini-2.0-flash-lite',
            });

            const result = await model.generateContent([
                {
                    text: 'Transcribe the following audio message exactly as spoken. Return ONLY the transcription text, nothing else. If the audio is in Hindi or Hinglish, transcribe it as-is in the original language using Roman script (transliteration). Do not translate.',
                },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Audio,
                    },
                },
            ]);

            const transcription = result.response.text().trim();
            console.log(`🎙️  Transcribed: "${transcription.slice(0, 100)}${transcription.length > 100 ? '...' : ''}"`);
            return transcription;
        } catch (error) {
            console.error('❌ Transcription failed:', error.message);
            return null;
        }
    }
}

module.exports = new TranscriptionService();
