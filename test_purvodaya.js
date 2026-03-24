require('dotenv').config();
const aiService = require('./src/services/ai.service');
const { Purvodaya } = require('./src/tenants.config');
const leadService = require('./src/services/lead.service');

async function testPurvodaya() {
    console.log('Testing Purvodaya AI Agent...\n');

    const history = [
        { role: 'user', content: 'Hi, I need a solar panel for my home in Gorakhpur. My electric bill is around Rs 3500. How much will it cost?' }
    ];

    console.log('User Message:', history[0].content);

    try {
        const response = await aiService.generateResponse(Purvodaya, history);
        console.log('\n🤖 AI Response:\n', response);

        const interest = leadService.extractInterest(history[0].content);
        console.log(`\n📋 Extracted Lead Intent: ${interest}`);

    } catch (e) {
        console.error('Error generating response:', e);
    }
    process.exit(0);
}

testPurvodaya();
