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
let planId = null;

async function getOrCreatePlan() {
  if (planId) return planId;
  
  try {
    // Attempt to fetch existing plans (we would normally store this in env or db)
    const plans = await razorpay.plans.all();
    const existingPlan = plans.items.find(p => p.item.amount === 29900 && p.period === 'monthly');
    
    if (existingPlan) {
      planId = existingPlan.id;
      return planId;
    }

    // Create a new plan: ₹299 / month
    const newPlan = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: 'Shoply AI Receptionist - Monthly',
        amount: 29900, // in paise (₹299)
        currency: 'INR',
        description: 'Unlimited AI Receptionist for all your businesses'
      }
    });
    
    planId = newPlan.id;
    return planId;
  } catch (err) {
    console.error('Error getting/creating plan:', err);
    throw err;
  }
}

router.post('/create-subscription', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan_id = await getOrCreatePlan();

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 1,
      total_count: 120, // 10 years
    });

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
      // Payment is legit
      await db.updateUserSubscription(userId, {
        subscription_status: 'active',
        razorpay_subscription_id: razorpay_subscription_id,
      });

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
