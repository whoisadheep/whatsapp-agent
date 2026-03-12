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
}

module.exports = new EvolutionService();
