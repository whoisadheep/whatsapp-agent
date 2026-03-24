const axios = require('axios');
const OpenAI = require('openai');

class TranscriptionService {
    constructor() {
        // ── Deepgram (Primary) ──
        this.deepgramKey = process.env.DEEPGRAM_API_KEY;
        if (this.deepgramKey) {
            console.log('🎙️  Transcription service ready (Deepgram — primary)');
        } else {
            console.warn('⚠️  DEEPGRAM_API_KEY not set — Deepgram transcription disabled.');
        }

        // ── NVIDIA (Fallback) ──
        this.nvidiaKey = process.env.NVIDIA_API_KEY;
        this.nvidiaBaseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
        this.nvidiaVisionModel = process.env.NVIDIA_VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';

        if (this.nvidiaKey) {
            this.nvidiaClient = new OpenAI({
                apiKey: this.nvidiaKey,
                baseURL: this.nvidiaBaseUrl,
            });
            console.log('🎙️  Transcription fallback ready (NVIDIA)');
        } else {
            this.nvidiaClient = null;
            console.warn('⚠️  NVIDIA_API_KEY not set — NVIDIA transcription fallback disabled.');
        }

        if (!this.deepgramKey && !this.nvidiaClient) {
            console.error('❌ No transcription provider configured! Voice messages will not work.');
        }
    }

    /**
     * Transcribe audio (base64) to text.
     * Tries Deepgram first, falls back to NVIDIA.
     * @param {string} base64Audio - Base64 encoded audio data
     * @param {string} mimeType - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
     * @returns {string|null} Transcribed text, or null on failure
     */
    async transcribe(base64Audio, mimeType = 'audio/ogg') {
        // Try Deepgram first
        if (this.deepgramKey) {
            try {
                const text = await this._deepgramTranscribe(base64Audio, mimeType);
                if (text) return text;
            } catch (error) {
                const errDetails = error.response?.data
                    ? JSON.stringify(error.response.data).slice(0, 300)
                    : error.message;
                console.error('❌ Deepgram transcription failed:', errDetails);
            }
        }

        // Fallback to NVIDIA
        if (this.nvidiaClient) {
            try {
                const text = await this._nvidiaTranscribe(base64Audio, mimeType);
                if (text) return text;
            } catch (error) {
                console.error('❌ NVIDIA transcription fallback failed:', error.message);
            }
        }

        console.error('❌ All transcription providers failed');
        return null;
    }

    /**
     * Transcribe using Deepgram REST API
     */
    async _deepgramTranscribe(base64Audio, mimeType) {
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        console.log(`🎙️  [Deepgram] Audio buffer size: ${audioBuffer.length} bytes, MIME: ${mimeType}`);

        if (audioBuffer.length < 100) {
            console.error('❌ [Deepgram] Audio buffer too small, likely empty/corrupt');
            return null;
        }

        // Clean MIME type for Content-Type header (remove codec info)
        const contentType = mimeType.split(';')[0].trim() || 'audio/ogg';

        const response = await axios.post(
            'https://api.deepgram.com/v1/listen',
            audioBuffer,
            {
                headers: {
                    'Authorization': `Token ${this.deepgramKey}`,
                    'Content-Type': contentType,
                },
                params: {
                    model: 'nova-2',
                    detect_language: true,
                    smart_format: true,
                    punctuate: true,
                },
                timeout: 30000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        );

        const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        const detectedLang = response.data?.results?.channels?.[0]?.detected_language;
        const confidence = response.data?.results?.channels?.[0]?.alternatives?.[0]?.confidence;

        if (transcript && transcript.trim().length > 0) {
            console.log(`🎙️  [Deepgram] Transcribed (lang=${detectedLang || 'unknown'}, conf=${confidence || '?'}): "${transcript.slice(0, 100)}${transcript.length > 100 ? '...' : ''}"`);
            return transcript.trim();
        }

        console.warn('⚠️  Deepgram returned empty transcript. Full response:', JSON.stringify(response.data).slice(0, 500));
        return null;
    }

    /**
     * Transcribe using NVIDIA vision model (fallback — sends audio as base64 data)
     * NVIDIA's Llama model doesn't natively handle audio, so we use a text prompt workaround.
     * This is a best-effort fallback.
     */
    async _nvidiaTranscribe(base64Audio, mimeType) {
        console.log('🎙️  [NVIDIA] Attempting transcription fallback...');

        // NVIDIA LLMs don't directly handle audio, so we'll try using the 
        // model's text capability to at minimum inform the user
        // This fallback mainly exists for when Deepgram is down
        const completion = await this.nvidiaClient.chat.completions.create({
            model: this.nvidiaVisionModel,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'The user sent a voice message but our transcription service is currently unavailable. Please respond naturally acknowledging you received a voice message and ask them to type their message instead. Return ONLY a brief, friendly response.',
                        },
                    ],
                },
            ],
            temperature: 0.3,
            max_tokens: 150,
        });

        // This won't be a real transcription, but a graceful fallback message
        const fallbackText = completion.choices?.[0]?.message?.content?.trim();
        if (fallbackText) {
            console.log('🎙️  [NVIDIA] Generated fallback response for voice message');
            // We return this as if it was the transcription, so the AI gets it and knows what happened.
            return "[VOICE MESSAGE RECEIVED BUT TRANSCRIPTION FAILED]: " + fallbackText; 
        }

        return null;
    }
}

module.exports = new TranscriptionService();
