const express = require('express');
const conversationService = require('../services/conversation.service');

const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'WhatsApp AI Agent',
        uptime: Math.floor(process.uptime()),
        activeConversations: conversationService.getActiveCount(),
        timestamp: new Date().toISOString(),
    });
});

module.exports = router;
