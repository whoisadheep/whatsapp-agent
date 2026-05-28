const { createClient } = require('@supabase/supabase-js');

// We use the same frontend anon key for verification. 
// Supabase's `getUser` securely verifies the token against the Supabase Auth server.
const supabaseUrl = process.env.SUPABASE_URL || 'https://sslmozbifqqooeviombu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_Cnou-hz3mTSOt6EBI7LHiA_VVoRfpV0';

const supabase = createClient(supabaseUrl, supabaseKey);

const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid Authorization header' });
        }

        const token = authHeader.split(' ')[1];
        
        // Securely verify token and get user from Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            console.error('Auth error:', error?.message);
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // Attach user to request for downstream routes
        req.user = user;
        next();
    } catch (err) {
        console.error('Server auth error:', err);
        res.status(500).json({ error: 'Internal server error during authentication' });
    }
};

module.exports = { requireAuth };
