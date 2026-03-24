const { EdgeTTS } = require('edge-tts-universal');

class TTSService {
    constructor() {
        // Microsoft Edge TTS doesn't need an API key!
        this.voiceId = process.env.EDGE_VOICE_ID || 'en-IN-NeerjaNeural';
        this.tts = new EdgeTTS();
        console.log(`🔊 TTS service ready (Microsoft Edge — voice: ${this.voiceId})`);
    }

    /**
     * Check if TTS is available (Edge TTS is always available as it's free)
     */
    isAvailable() {
        return true;
    }

    /**
     * Convert text to speech using Microsoft Edge TTS.
     * Returns base64-encoded MP3 audio.
     * @param {string} text - Text to convert to speech
     * @param {string} voiceId - Optional voice ID override
     * @returns {string|null} Base64-encoded audio (MP3) or null on failure
     */
    async textToSpeech(text, voiceId = null) {
        try {
            // Clean text (remove special characters or markdown tags if any)
            const cleanText = text.replace(/\[[A-Z_]+\]/g, '').trim();
            
            if (!cleanText) return null;

            // Set metadata for the desired voice and format
            // Common formats: 'audio-24khz-48kbitrate-mono-mp3', 'audio-24khz-96kbitrate-mono-mp3'
            await this.tts.setMetadata(voiceId || this.voiceId, 'audio-24khz-48kbitrate-mono-mp3');
            
            console.log(`🔊 [Edge TTS] Generating speech for: "${cleanText.slice(0, 50)}..."`);
            
            // Generate audio buffer
            const audioBuffer = await this.tts.getAudio(cleanText);
            
            if (!audioBuffer || audioBuffer.length === 0) {
                console.warn('⚠️  Edge TTS returned empty buffer');
                return null;
            }

            const base64Audio = audioBuffer.toString('base64');
            console.log(`🔊 Edge TTS generated (${Math.round(base64Audio.length / 1024)} KB)`);
            return base64Audio;
        } catch (error) {
            console.error('❌ Edge TTS failed:', error.message);
            return null;
        }
    }
}

module.exports = new TTSService();
