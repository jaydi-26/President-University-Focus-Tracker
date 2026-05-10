require('dotenv').config();
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const midtransClient = require('midtrans-client');
const cors = require('cors');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production: credentials stored as a JSON env variable on Vercel
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // Local dev: read from the key file
        serviceAccount = require('./firebase-key.json.json');
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin Initialized.');
} catch (error) {
    console.error('⚠️  Firebase Admin Error:', error.message);
}

// Initialize Midtrans Snap (Sandbox mode — set isProduction: true when going live)
const snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// ─── Serve Static Files ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── API: Status Check ───────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({
        status: 'Server is running',
        database: admin.apps.length > 0 ? 'connected' : 'disconnected',
        midtrans: process.env.MIDTRANS_SERVER_KEY ? 'configured' : 'NOT configured — add keys to .env'
    });
});

// ─── API: Create Midtrans Transaction ───────────────────────────────────────
// Called by the frontend to get a Snap transaction token for the payment popup.
app.post('/api/create-transaction', async (req, res) => {
    try {
        const { userId, userName, userEmail, plan } = req.body;

        if (!userId || !plan) {
            return res.status(400).json({ error: 'Missing userId or plan.' });
        }

        const planDetails = {
            monthly: { name: 'PUFT Premium Monthly', price: 50000 },
            yearly:  { name: 'PUFT Premium Yearly',  price: 500000 }
        };

        const selected = planDetails[plan] || planDetails.monthly;

        // A unique order ID for every transaction attempt
        const orderId = `PUFT-${userId.slice(0, 8)}-${Date.now()}`;

        const parameter = {
            transaction_details: {
                order_id:     orderId,
                gross_amount: selected.price
            },
            item_details: [{
                id:       plan,
                price:    selected.price,
                quantity: 1,
                name:     selected.name
            }],
            customer_details: {
                first_name: userName  || 'PUFT User',
                email:      userEmail || 'user@puft.app'
            }
        };

        const token = await snap.createTransactionToken(parameter);

        console.log(`💳 Transaction token created for ${userName} (${plan}): ${orderId}`);
        res.json({ token, orderId });

    } catch (error) {
        console.error('❌ Midtrans error:', error.message);
        res.status(500).json({ error: 'Failed to create transaction. ' + error.message });
    }
});

// ─── API: Start Free Trial ───────────────────────────────────────────────────
// Grants 14-day premium access without charging. One trial per account ever.
app.post('/api/start-trial', async (req, res) => {
    try {
        const { userId, plan } = req.body;
        if (!userId || !plan) {
            return res.status(400).json({ error: 'Missing userId or plan.' });
        }

        const db = admin.firestore();
        const userRef = db.collection('users').doc(userId);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const userData = userSnap.data();

        // ── Prevent trial abuse: one trial per account ever ─────────────
        if (userData.trial_used === true) {
            return res.status(403).json({ error: 'Trial already used. Please subscribe to continue.' });
        }

        const now = new Date();
        const trialEnd = new Date(now);
        trialEnd.setDate(trialEnd.getDate() + 14); // 14 days from now

        await userRef.update({
            is_premium:      true,
            is_trial:        true,
            trial_used:      true,           // permanent flag — can never trial again
            trial_plan:      plan,
            trial_start:     now.toISOString(),
            trial_end:       trialEnd.toISOString(),
            subscription_plan: null,
            subscription_started: null
        });

        console.log(`🎁 Trial started for userId=${userId} (${plan}) — expires ${trialEnd.toDateString()}`);
        res.json({ success: true, trial_end: trialEnd.toISOString() });

    } catch (error) {
        console.error('❌ Trial error:', error.message);
        res.status(500).json({ error: 'Failed to start trial. ' + error.message });
    }
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`🚀 Server running: http://localhost:${PORT}`);
    console.log(`=================================`);
    console.log('Press CTRL + C to stop.');
});
