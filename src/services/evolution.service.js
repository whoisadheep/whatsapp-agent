const axios = require('axios');

class EvolutionService {
  constructor() {
    this.apiUrl = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
    this.apiKey = process.env.EVOLUTION_API_KEY || 'supersecretapikey';

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.apiKey,
      },
      timeout: 30000,
    });
  }

  async createInstance(instanceName) {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.post('/instance/create', {
        instanceName: instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
      });
      console.log(`✅ Instance "${instanceName}" created successfully`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 403 || error.response?.data?.message?.includes('already')) {
        console.log(`ℹ️  Instance "${instanceName}" already exists`);
        return null;
      }
      console.error(`❌ Failed to create instance ${instanceName}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async setWebhook(instanceName, webhookUrl) {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.post(`/webhook/set/${instanceName}`, {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: [
            'MESSAGES_UPSERT',
            'CONNECTION_UPDATE',
            'QRCODE_UPDATED',
          ],
        },
      });
      console.log(`✅ Webhook configured for ${instanceName}: ${webhookUrl}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to set webhook for ${instanceName}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async sendText(instanceName, number, text) {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.post(`/message/sendText/${instanceName}`, {
        number,
        text,
      });
      console.log(`📤 Reply sent to ${number} via ${instanceName}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to send message to ${number} via ${instanceName}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Send an image (base64) via WhatsApp
   * @param {string} instanceName
   * @param {string} number
   * @param {string} base64Image Base64 encoded image (without data: prefix)
   * @param {string} caption Optional caption
   */
  async sendImage(instanceName, number, base64Image, caption = '') {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.post(`/message/sendMedia/${instanceName}`, {
        number,
        mediatype: 'image',
        mimetype: 'image/png',
        caption,
        media: `data:image/png;base64,${base64Image}`,
        fileName: 'payment_qr.png',
      });
      console.log(`🖼️ Image sent to ${number} via ${instanceName}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to send image to ${number} via ${instanceName}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async getInstanceStatus(instanceName) {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.get(`/instance/connectionState/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to get instance status for ${instanceName}:`, error.response?.data || error.message);
      return null;
    }
  }

  async getQrCode(instanceName) {
    if (!instanceName) throw new Error('instanceName is required');
    try {
      const response = await this.client.get(`/instance/connect/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to get QR code for ${instanceName}:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Download media (image, video, etc.) from Evolution API v2
   * @param {string} instanceName 
   * @param {string} messageId The ID of the message to download media from
   * @returns {string|null} Base64 string of the media
   */
  async downloadMedia(instanceName, messageId) {
    if (!instanceName || !messageId) throw new Error('instanceName and messageId are required');
    try {
      // In v2, we often use getBase64FromMediaMessage
      const response = await this.client.post(`/chat/getBase64FromMediaMessage/${instanceName}`, {
        messageId: messageId
      });
      
      // Evolution API returns base64 inside the response
      return response.data?.base64 || response.data;
    } catch (error) {
      console.error(`❌ Failed to download media from ${instanceName}:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Generate an 8-digit pairing code for remote WhatsApp linking
   * @param {string} instanceName 
   * @param {string} number Phone number with country code (e.g., 919005149776)
   * @returns {string|null} The 8-digit code
   */
  async getPairingCode(instanceName, number) {
    if (!instanceName || !number) throw new Error('instanceName and number are required');
    try {
      const response = await this.client.get(`/instance/connect/${instanceName}`, {
        params: { number }
      });
      
      // Evolution API returns { code: "ABC-DEF-GH" } or similar
      return response.data?.code || null;
    } catch (error) {
      console.error(`❌ Failed to get pairing code for ${instanceName}:`, error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = new EvolutionService();
