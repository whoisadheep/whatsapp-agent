require('dotenv').config();
const db = require('./src/services/db.service');
const reviewService = require('./src/services/review.service');

async function verifyReviewBooster() {
    console.log('Testing Review Booster Feature...\n');

    await db.connect();
    
    // Simulate database insertion and review scheduling
    const scheduled = await reviewService.scheduleReview('purvodaya', 'Test Customer', '919876543210');
    
    if (scheduled) {
        console.log('✅ Successfully scheduled review request!');
        
        // Show what's in the DB
        const result = await db.query("SELECT * FROM review_requests ORDER BY created_at DESC LIMIT 1");
        console.log('\n📋 DB Entry:', result.rows[0]);
    } else {
        console.log('❌ Failed to schedule.');
    }

    process.exit(0);
}

verifyReviewBooster();
