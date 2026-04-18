# WhatsApp AI Agent 🤖

A multi-tenant, autonomous WhatsApp AI agent designed for business automation. Powered by **Google Gemini**, **NVIDIA NIM**, and connected via the **Evolution API**.

## 🚀 Overview

This agent acts as a personalized assistant that can handle customer inquiries, manage leads, process reviews, and even transcribe voice messages—all while maintaining a natural, human-like interaction style.

## ✨ Key Features

- **Multi-Tenant Architecture**: Support for multiple business profiles/tenants with isolated configurations.
- **AI-Driven Conversations**: Uses Google Gemini (Pro/Flash) and NVIDIA NIM (Llama 3.1 70B / Llama 3.2 90B Vision) for high-quality responses.
- **Voice Intelligence**:
  - **Transcription**: Convert voice messages to text using Deepgram or Gemini's native capabilities.
  - **TTS (Text-to-Speech)**: Reply with high-quality AI voices via ElevenLabs or Edge-TTS.
- **Human Takeover**: Intelligent pause mechanism that stops the AI when the business owner replies manually.
- **Lead & Review Management**: Automatically logs potential leads and manages customer reviews with localized tone (Hinglish support).
- **Missed Call Auto-Reply**: Integration with the Ringl Android app to handle missed calls via WhatsApp.
- **Dockerized**: Easy deployment using Docker and Docker Compose.

## 🛠️ Tech Stack

- **Backend**: Node.js & Express
- **Database**: PostgreSQL (Persistence for conversations and tenant settings)
- **WhatsApp Integration**: [Evolution API](https://github.com/EvolutionAPI/evolution-api)
- **AI Models**: Google Generative AI (Gemini), NVIDIA NIM
- **Voice Services**: Deepgram, ElevenLabs, Edge-TTS

## ⚙️ Setup & Installation

### Prerequisites

- Node.js (v18+)
- PostgreSQL
- Evolution API instance (running locally or remotely)
- API Keys for Gemini, Deepgram, etc.

### Environment Variables

Create a `.env` file in the root directory and configure the following:

```env
# Server
PORT=3001
MESSAGE_DEBOUNCE_MS=5000

# Evolution API
EVOLUTION_API_URL=your_evolution_api_url
EVOLUTION_API_KEY=your_api_key
EVOLUTION_INSTANCE=your_instance_name

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/your_db

# Voice Services (Optional)
DEEPGRAM_API_KEY=your_deepgram_key
ELEVENLABS_API_KEY=your_elevenlabs_key

# Human Takeover
HUMAN_TAKEOVER_TIMEOUT_MS=1800000
```

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/whoisadheep/whatsapp-agent.git
   cd whatsapp-agent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup Database:
   ```bash
   # Ensure PostgreSQL is running and runs the initial schema
   node src/services/db.service.js # (Verify if migrations are needed)
   ```

4. Start the server:
   ```bash
   npm run dev
   ```

## 🐳 Docker Deployment

The project includes a `Dockerfile` for containerized deployment.

```bash
docker build -t whatsapp-agent .
docker run -p 3001:3001 --env-file .env whatsapp-agent
```

## 📂 Project Structure

- `src/app.js`: Application entry point and middleware.
- `src/services/`: Core logic (AI, Evolution API, DB, TTS, etc.).
- `src/routes/`: Webhook and API endpoints.
- `src/tenants.config.js`: Configuration for different business tenants.

## 🤝 Contributing

Feel free to open issues or submit pull requests to improve the agent!

## 📄 License

This project is licensed under the MIT License.
