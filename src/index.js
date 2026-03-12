require('dotenv').config();

const { app, initializeTenants } = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       🤖 WhatsApp AI Agent v1.0.0           ║
╠══════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}            ║
║  Webhook:   POST /webhook                    ║
║  Health:    GET  /health                     ║
║  AI Model:  Gemini 2.0 Flash                 ║
╚══════════════════════════════════════════════╝
  `);

  // Initialize Evolution API connection for all tenants
  initializeTenants();
});
