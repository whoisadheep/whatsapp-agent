const db = require('./db.service');
const evolutionService = require('./evolution.service');
const tenantService = require('./tenant.service');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Config defaults ───────────────────────────────────────────────────────
const DEFAULT_BRIEFING_HOUR = 8;   // 8 AM daily
const LOOKBACK_HOURS = 24;  // analyse last 24 h of data

class BusinessCoachService {
    constructor() {
        this.cronTimer = null;
        this.isRunning = false;

        // Re-use same AI providers as ai.service for consistency
        this.nvidiaKey = process.env.NVIDIA_API_KEY;
        this.nvidiaBaseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
        this.nvidiaModel = process.env.NVIDIA_MODEL_NAME || 'meta/llama-3.1-405b-instruct';
        this.geminiKey = process.env.GEMINI_API_KEY;

        if (this.nvidiaKey) {
            this.nvidiaClient = new OpenAI({ apiKey: this.nvidiaKey, baseURL: this.nvidiaBaseUrl });
        }
        if (this.geminiKey) {
            this.geminiAI = new GoogleGenerativeAI(this.geminiKey);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════════

    async init() {
        if (!db.isConnected()) {
            console.warn('⚠️  BusinessCoach: DB not connected, coach disabled.');
            return;
        }

        await this._ensureTables();
        this._scheduleCron();
        console.log('🤖 AI Business Coach initialised — daily briefings active.');
    }

    async _ensureTables() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS coach_briefings (
                id            SERIAL PRIMARY KEY,
                tenant_id     VARCHAR(50)  NOT NULL,
                briefing_date DATE         NOT NULL DEFAULT CURRENT_DATE,
                metrics       JSONB,
                insights      TEXT,
                sent_at       TIMESTAMP,
                status        VARCHAR(20)  DEFAULT 'pending',
                created_at    TIMESTAMP    DEFAULT NOW(),
                UNIQUE (tenant_id, briefing_date)
            )
        `);
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_coach_tenant_date
            ON coach_briefings(tenant_id, briefing_date)
        `);
        console.log('✅ BusinessCoach tables ready');
    }

    // ═══════════════════════════════════════════════════════════════
    //  SCHEDULING
    // ═══════════════════════════════════════════════════════════════

    _scheduleCron() {
        const now = new Date();
        const next = new Date();
        const hour = parseInt(process.env.COACH_BRIEFING_HOUR ?? DEFAULT_BRIEFING_HOUR);

        next.setHours(hour, 0, 0, 0);
        if (now >= next) next.setDate(next.getDate() + 1);

        const delayMs = next - now;
        console.log(`📅 Next business coach briefing: ${next.toLocaleString()} (in ${Math.round(delayMs / 60000)} min)`);

        if (this.cronTimer) clearTimeout(this.cronTimer);
        this.cronTimer = setTimeout(async () => {
            await this.sendAllBriefings();
            this._scheduleCron();           // reschedule for next day
        }, delayMs);
    }

    // ═══════════════════════════════════════════════════════════════
    //  METRICS COLLECTION
    // ═══════════════════════════════════════════════════════════════

    async _collectMetrics(tenantId) {
        const since = `NOW() - INTERVAL '${LOOKBACK_HOURS} hours'`;

        const [
            msgResult,
            leadsResult,
            newCustomersResult,
            returningResult,
            topQueriesResult,
            sentimentResult,
            convRateResult,
            reviewsResult,
        ] = await Promise.all([
            // Total messages exchanged
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE role = 'user')      AS user_msgs,
                    COUNT(*) FILTER (WHERE role = 'assistant') AS ai_msgs,
                    COUNT(DISTINCT phone)                       AS unique_contacts
                FROM messages
                WHERE tenant_id = $1 AND created_at >= ${since}
            `, [tenantId]),

            // Lead stats
            db.query(`
                SELECT
                    COUNT(*)                                        AS total,
                    COUNT(*) FILTER (WHERE status = 'new')         AS new_leads,
                    COUNT(*) FILTER (WHERE status = 'converted')   AS converted,
                    array_agg(DISTINCT interest ORDER BY interest) AS interests
                FROM leads
                WHERE tenant_id = $1 AND created_at >= ${since}
            `, [tenantId]),

            // New customers (first time in last 24h)
            db.query(`
                SELECT COUNT(*) AS count
                FROM customers
                WHERE tenant_id = $1 AND first_seen >= ${since}
            `, [tenantId]),

            // Returning customers active in last 24h but older
            db.query(`
                SELECT COUNT(*) AS count
                FROM customers
                WHERE tenant_id = $1 AND last_seen >= ${since} AND first_seen < ${since}
            `, [tenantId]),

            // Most common customer message keywords (top 10 words)
            db.query(`
                SELECT word, COUNT(*) AS freq
                FROM (
                    SELECT regexp_split_to_table(lower(content), E'\\\\s+') AS word
                    FROM messages
                    WHERE tenant_id = $1 AND role = 'user' AND created_at >= ${since}
                ) w
                WHERE length(word) > 4
                  AND word NOT IN ('hello','hi','okay','please','thanks','thank','kaise','aapka','mujhe','chahiye','hoga','karna')
                GROUP BY word
                ORDER BY freq DESC
                LIMIT 10
            `, [tenantId]),

            // Rough sentiment: count messages with negative keywords
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE content ~* '(problem|issue|not working|broken|complaint|kharab|dikkat|pareshan|angry|upset|refund|return|wrong)') AS negative,
                    COUNT(*) FILTER (WHERE content ~* '(great|excellent|perfect|superb|amazing|thank|love|best|bahut accha|shukriya|satisfied)') AS positive,
                    COUNT(*) AS total
                FROM messages
                WHERE tenant_id = $1 AND role = 'user' AND created_at >= ${since}
            `, [tenantId]),

            // Conversion rate: leads that ended up as converted
            db.query(`
                SELECT
                    ROUND(
                        100.0 * COUNT(*) FILTER (WHERE status = 'converted') / NULLIF(COUNT(*), 0),
                        1
                    ) AS rate
                FROM leads WHERE tenant_id = $1
            `, [tenantId]),

            // Review requests sent in last 24h
            db.query(`
                SELECT COUNT(*) AS sent
                FROM review_requests
                WHERE tenant_id = $1 AND status = 'sent' AND created_at >= ${since}
            `, [tenantId]),
        ]);

        const msgs = msgResult?.rows[0] || {};
        const leads = leadsResult?.rows[0] || {};
        const newCust = newCustomersResult?.rows[0] || {};
        const returning = returningResult?.rows[0] || {};
        const topWords = topQueriesResult?.rows || [];
        const sentiment = sentimentResult?.rows[0] || {};
        const convRate = convRateResult?.rows[0] || {};
        const reviews = reviewsResult?.rows[0] || {};

        const totalSentiment = parseInt(sentiment.total) || 1;
        const sentimentScore = Math.round(
            ((parseInt(sentiment.positive) || 0) - (parseInt(sentiment.negative) || 0))
            / totalSentiment * 100
        );

        return {
            messages: {
                fromCustomers: parseInt(msgs.user_msgs) || 0,
                fromAI: parseInt(msgs.ai_msgs) || 0,
                uniqueContacts: parseInt(msgs.unique_contacts) || 0,
            },
            customers: {
                new: parseInt(newCust.count) || 0,
                returning: parseInt(returning.count) || 0,
            },
            leads: {
                total: parseInt(leads.total) || 0,
                new: parseInt(leads.new_leads) || 0,
                converted: parseInt(leads.converted) || 0,
                interests: leads.interests?.filter(Boolean) || [],
            },
            sentiment: {
                score: sentimentScore,          // -100 to +100
                positive: parseInt(sentiment.positive) || 0,
                negative: parseInt(sentiment.negative) || 0,
            },
            conversionRate: parseFloat(convRate.rate) || 0,
            reviewsSent: parseInt(reviews.sent) || 0,
            topKeywords: topWords.map(r => ({ word: r.word, count: parseInt(r.freq) })),
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  AI INSIGHT GENERATION
    // ═══════════════════════════════════════════════════════════════

    async _generateInsights(tenant, metrics) {
        const prompt = this._buildCoachPrompt(tenant, metrics);

        // Try NVIDIA first, fall back to Gemini
        if (this.nvidiaClient) {
            try {
                const completion = await this.nvidiaClient.chat.completions.create({
                    model: this.nvidiaModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.4,
                    max_tokens: 800,
                });
                const text = completion.choices[0]?.message?.content?.trim();
                if (text) return text;
            } catch (err) {
                console.error('BusinessCoach NVIDIA error:', err.message);
            }
        }

        if (this.geminiAI) {
            try {
                const model = this.geminiAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
                const result = await model.generateContent(prompt);
                const text = result.response.text()?.trim();
                if (text) return text;
            } catch (err) {
                console.error('BusinessCoach Gemini error:', err.message);
            }
        }

        return null;
    }

    _buildCoachPrompt(tenant, m) {
        const sentimentLabel =
            m.sentiment.score > 20 ? 'Positive 😊' :
                m.sentiment.score < -20 ? 'Negative 😟' : 'Neutral 😐';

        const keywordsText = m.topKeywords.slice(0, 6).map(k => `"${k.word}" (${k.count}x)`).join(', ');
        const interestsText = m.leads.interests.slice(0, 5).join(', ') || 'None captured';

        return `You are an expert AI business coach for small businesses in India. 
Your job is to give the business owner a DAILY BRIEFING on WhatsApp in a professional yet warm tone.

Business: ${tenant.name}
Date: ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

YESTERDAY'S DATA (last 24 hours):
- Customer messages received: ${m.messages.fromCustomers}
- AI replies sent: ${m.messages.fromAI}
- Unique contacts: ${m.messages.uniqueContacts}
- New customers: ${m.customers.new}
- Returning customers: ${m.customers.returning}
- New leads captured: ${m.leads.new}
- Leads converted: ${m.leads.converted}
- Overall conversion rate: ${m.conversionRate}%
- Customer sentiment: ${sentimentLabel} (score: ${m.sentiment.score}/100)
- Positive interactions: ${m.sentiment.positive} | Negative: ${m.sentiment.negative}
- Top customer keywords: ${keywordsText || 'Not enough data'}
- Top customer interests: ${interestsText}
- Google review requests sent: ${m.reviewsSent}

Write a WhatsApp briefing message with EXACTLY these 5 sections using WhatsApp formatting (* for bold, numbered lists):
1. A one-line greeting with the date
2. *📊 Performance Summary* — key numbers in 3-4 bullet points, highlight wins or drops
3. *🧠 Key Insights* — 2 observations about customer behaviour or trends based on the data
4. *💡 3 Action Items for Today* — specific, concrete things the owner should do today to improve results
5. *⚠️ Watch Out* — one risk or concern based on the data (e.g., high negative sentiment, low conversion)

Rules:
- Be specific to this business type (${tenant.name})
- Use Hinglish if the business serves Hindi-speaking customers (Purvodaya, SaiInfotek)
- Keep total length under 350 words
- Be encouraging but honest
- Do NOT use markdown headers like ## or ---
- End with a short motivational line`;
    }

    // ═══════════════════════════════════════════════════════════════
    //  MESSAGE FORMATTING
    // ═══════════════════════════════════════════════════════════════

    _formatFallbackMessage(tenant, metrics) {
        const m = metrics;
        const now = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

        return `🤖 *AI Business Coach — ${now}*\n\n` +
            `*📊 Performance Summary*\n` +
            `• Messages received: ${m.messages.fromCustomers}\n` +
            `• Unique contacts: ${m.messages.uniqueContacts}\n` +
            `• New leads: ${m.leads.new} | Converted: ${m.leads.converted}\n` +
            `• New customers: ${m.customers.new} | Returning: ${m.customers.returning}\n` +
            `• Sentiment: ${m.sentiment.score > 0 ? '😊 Positive' : m.sentiment.score < 0 ? '😟 Needs attention' : '😐 Neutral'}\n\n` +
            `*💡 Action Items*\n` +
            `1. Follow up on ${m.leads.new} new lead(s) captured yesterday\n` +
            `2. Review any negative interactions (${m.sentiment.negative} flagged)\n` +
            `3. Keep the momentum — ${m.customers.returning} customers came back!\n\n` +
            `_Have a productive day! 💪_`;
    }

    // ═══════════════════════════════════════════════════════════════
    //  SEND BRIEFING
    // ═══════════════════════════════════════════════════════════════

    async sendBriefingForTenant(tenant) {
        if (!tenant.ownerPhone) {
            console.warn(`⚠️  BusinessCoach: no ownerPhone for ${tenant.name}, skipping.`);
            return false;
        }

        try {
            console.log(`\n🤖 BusinessCoach: Generating briefing for ${tenant.name}...`);

            const metrics = await this._collectMetrics(tenant.id);
            const insights = await this._generateInsights(tenant, metrics);
            const message = insights || this._formatFallbackMessage(tenant, metrics);

            // Persist to DB before sending
            await db.query(`
                INSERT INTO coach_briefings (tenant_id, briefing_date, metrics, insights, status)
                VALUES ($1, CURRENT_DATE, $2, $3, 'sending')
                ON CONFLICT (tenant_id, briefing_date)
                DO UPDATE SET metrics = $2, insights = $3, status = 'sending'
            `, [tenant.id, JSON.stringify(metrics), message]);

            const cleanPhone = tenant.ownerPhone.replace(/\D/g, '');
            await evolutionService.sendText(tenant.instanceName, cleanPhone, message);

            // Mark sent
            await db.query(`
                UPDATE coach_briefings
                SET status = 'sent', sent_at = NOW()
                WHERE tenant_id = $1 AND briefing_date = CURRENT_DATE
            `, [tenant.id]);

            console.log(`✅ BusinessCoach briefing sent to ${tenant.name} (${cleanPhone})`);
            return true;

        } catch (error) {
            console.error(`❌ BusinessCoach failed for ${tenant.name}:`, error.message);

            await db.query(`
                UPDATE coach_briefings SET status = 'failed'
                WHERE tenant_id = $1 AND briefing_date = CURRENT_DATE
            `, [tenant.id]).catch(() => { });

            return false;
        }
    }

    async sendAllBriefings() {
        if (this.isRunning) {
            console.warn('⚠️  BusinessCoach: already running, skipping duplicate trigger.');
            return;
        }
        this.isRunning = true;

        try {
            const tenants = tenantService.getAllTenants();
            console.log(`\n🤖 BusinessCoach: Sending briefings to ${tenants.length} tenant(s)...`);

            for (const tenant of tenants) {
                await this.sendBriefingForTenant(tenant);
                // Small delay between tenants to avoid rate limits
                await new Promise(r => setTimeout(r, 2000));
            }
        } finally {
            this.isRunning = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  MANUAL TRIGGER (for testing / on-demand via API)
    // ═══════════════════════════════════════════════════════════════

    async triggerManual(tenantId) {
        const tenant = tenantService.getTenantById(tenantId);
        if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
        return this.sendBriefingForTenant(tenant);
    }

    // ═══════════════════════════════════════════════════════════════
    //  HISTORY
    // ═══════════════════════════════════════════════════════════════

    async getBriefingHistory(tenantId, limit = 7) {
        if (!db.isConnected()) return [];
        const result = await db.query(`
            SELECT briefing_date, metrics, insights, status, sent_at
            FROM coach_briefings
            WHERE tenant_id = $1
            ORDER BY briefing_date DESC
            LIMIT $2
        `, [tenantId, limit]);
        return result?.rows || [];
    }
}

module.exports = new BusinessCoachService();