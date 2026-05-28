const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../services/db.service');
const { requireAuth } = require('../middleware/auth.middleware');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Since we are using an ad-hoc monthly subscription flow, it's often easier
// to use the Orders API if we aren't managing complex plans via Razorpay Dashboard.
// However, since we want a "Subscription", we need a Plan ID.
// For the sake of simplicity and robustness without requiring manual dashboard setup,
// we will create a recurring Order OR a Plan dynamically.
// Actually, Razorpay allows creating plans via API.
let planCache = {
  ringl: null,
  ai: null,
  combo: null
};

// Temp store to map subscription_id -> tier pending verification
const pendingSubscriptions = new Map();

const PLAN_DETAILS = {
  ringl: { amount: 10000, name: 'Ringl Auto-Reply Only - Monthly', desc: 'Unlimited Missed Call Auto-Replies' },
  ai: { amount: 24900, name: 'Shoply AI Assistant Only - Monthly', desc: 'Unlimited AI Chat Assistant' },
  combo: { amount: 29900, name: 'Shoply AI + Ringl Combo - Monthly', desc: 'Full Suite: AI Assistant & Missed Call Auto-Replies' }
};

async function getOrCreatePlan(tier) {
  if (planCache[tier]) return planCache[tier];
  
  const details = PLAN_DETAILS[tier];
  if (!details) throw new Error('Invalid tier');

  try {
    const plans = await razorpay.plans.all();
    const existingPlan = plans.items.find(p => p.item.amount === details.amount && p.period === 'monthly' && p.item.name === details.name);
    
    if (existingPlan) {
      planCache[tier] = existingPlan.id;
      return existingPlan.id;
    }

    const newPlan = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: details.name,
        amount: details.amount,
        currency: 'INR',
        description: details.desc
      }
    });
    
    planCache[tier] = newPlan.id;
    return newPlan.id;
  } catch (err) {
    console.error('Error getting/creating plan:', err);
    throw err;
  }
}

router.post('/create-subscription', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const tier = req.body.tier || 'combo';
    const plan_id = await getOrCreatePlan(tier);

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 1,
      total_count: 120, // 10 years
    });

    pendingSubscriptions.set(subscription.id, tier);

    res.json({
      subscription_id: subscription.id,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Error creating subscription:', err);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.post('/verify', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    const generated_signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_payment_id + '|' + razorpay_subscription_id)
      .digest('hex');

    if (generated_signature === razorpay_signature) {
      const tier = pendingSubscriptions.get(razorpay_subscription_id) || 'combo';
      
      // Payment is legit
      await db.updateUserSubscription(userId, {
        subscription_status: 'active',
        subscription_tier: tier,
        razorpay_subscription_id: razorpay_subscription_id,
      });

      pendingSubscriptions.delete(razorpay_subscription_id);

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Also provide an endpoint to check subscription status for the frontend
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const sub = await db.getUserSubscription(userId);
    res.json(sub || { subscription_status: 'trialing' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

module.exports = router;
