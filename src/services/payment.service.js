const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

class PaymentService {
    /**
     * Generate a UPI QR code as a base64 PNG string
     * @param {string} upiId - UPI ID (e.g., "9839994285@upi")
     * @param {string} payeeName - Name of the payee
     * @param {number|null} amount - Optional amount to pre-fill
     * @param {string|null} note - Optional transaction note
     * @returns {string|null} Base64 encoded PNG image (without data: prefix)
     */
    async generateUpiQr(upiId, payeeName, amount = null, note = null) {
        try {
            // Build UPI deep link
            let upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}`;
            if (amount) upiUrl += `&am=${amount}`;
            if (note) upiUrl += `&tn=${encodeURIComponent(note)}`;

            // Generate QR code as base64 (data URL format → strip prefix)
            const dataUrl = await QRCode.toDataURL(upiUrl, {
                width: 512,
                margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' },
            });

            // Strip the "data:image/png;base64," prefix to get raw base64
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');

            console.log(`💳 UPI QR generated for ${payeeName} (${upiId})${amount ? ` — ₹${amount}` : ''}`);
            return base64;
        } catch (error) {
            console.error('❌ Failed to generate UPI QR:', error.message);
            return null;
        }
    }

    /**
     * Try to get a pre-uploaded static QR image for a tenant
     * @param {string} tenantId 
     * @returns {string|null} Base64 string of the image
     */
    async getStaticQr(tenantId) {
        try {
            const filePath = path.join(__dirname, '../assets', `qr_${tenantId}.png`);
            await fs.access(filePath);
            const buffer = await fs.readFile(filePath);
            
            console.log(`🖼️  Static QR image found for ${tenantId}`);
            return buffer.toString('base64');
        } catch (error) {
            // File doesn't exist – that's expected if no static QR is uploaded
            return null;
        }
    }
}

module.exports = new PaymentService();
