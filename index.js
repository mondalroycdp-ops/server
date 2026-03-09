require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// IMPORTANT: Replace with your actual Firebase Admin SDK json
let serviceAccount = require('./firebaseServiceAccount.json');

// Fix for Render / other hosting: replace escaped newlines with actual newlines
if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://wp-test-plugn-default-rtdb.firebaseio.com"
});

const db = admin.database();
const app = express();

app.use(cors());
app.use(express.json());

// Root endpoint just to show the server is running
app.get('/', (req, res) => {
    res.send('License Validation Server is running.');
});

// WordPress Endpoint to check license & register webhook
// GET route to inform users who try to open it in their browser
app.get('/api/validate', (req, res) => {
    console.log(`[GET] /api/validate - Someone opened the API URL in their browser.`);
    res.status(405).json({
        message: 'Method Not Allowed. This endpoint expects a POST request with your license details.',
        example_body: {
            licenseKey: 'XXXX-XXXX-XXXX-XXXX',
            domain: 'yourwebsite.com'
        }
    });
});

// POST route for actual license validation
app.post('/api/validate', async (req, res) => {
    const { licenseKey, domain, webhookUrl } = req.body;
    console.log(`\n[POST] /api/validate - Received validation request!`);
    console.log(`       Key: ${licenseKey || 'None'}`);
    console.log(`       Domain: ${domain || 'None'}`);

    if (!licenseKey) {
        console.log(`       Result: Failed - No license key provided.`);
        return res.status(400).json({ valid: false, message: 'License key is required.' });
    }

    try {
        const licenseRef = db.ref('licenses').orderByChild('key').equalTo(licenseKey);
        const snapshot = await licenseRef.once('value');

        if (!snapshot.exists()) {
            console.log(`       Result: Failed - Key not found in database.`);
            return res.status(404).json({ valid: false, message: 'Invalid license key.' });
        }

        const val = snapshot.val();
        const licenseId = Object.keys(val)[0];
        const license = val[licenseId];

        const now = new Date().getTime();
        const expiry = new Date(license.expiryDate).getTime();

        // Check expiration
        if (now > expiry) {
            console.log(`       Result: Failed - License key expired.`);
            return res.status(403).json({
                valid: false,
                message: 'Your license key has expired. Please renew.'
            });
        }

        // Register domain & webhook URL for future push notifications
        const updates = {};
        if (!license.domain && domain) {
            updates.domain = domain;
            updates.activatedAt = new Date().toISOString();
        }
        if (webhookUrl && license.webhookUrl !== webhookUrl) {
            updates.webhookUrl = webhookUrl;
        }

        if (Object.keys(updates).length > 0) {
            await db.ref(`licenses/${licenseId}`).update(updates);
            console.log(`       Updated Domain/Webhook in database.`);
        } else if (license.domain && license.domain !== domain) {
            console.log(`       Result: Failed - License in use on another domain. Expected: ${license.domain}, Got: ${domain}`);
            return res.status(403).json({ valid: false, message: 'License in use on another domain.' });
        }

        console.log(`       Result: SUCCESS - License is Valid!`);
        return res.status(200).json({
            valid: true,
            expiresAt: license.expiryDate,
            message: 'License key is active.'
        });

    } catch (error) {
        console.error('Error validating:', error);
        console.log(`       Result: Failed - Internal Server Error`);
        return res.status(500).json({ valid: false, message: 'Internal Server Error' });
    }
});

// CRON JOB: Runs every day at 00:00 to check for expired licenses and notify WordPress
cron.schedule('0 0 * * *', async () => {
    console.log('Running daily expiration check...');
    try {
        const snapshot = await db.ref('licenses').once('value');
        if (!snapshot.exists()) return;

        const licenses = snapshot.val();
        const now = new Date().getTime();

        for (const id in licenses) {
            const license = licenses[id];
            // Only notify if there is a webhook URL and domain set up
            if (license.webhookUrl && license.status === 'active') {
                const expiry = new Date(license.expiryDate).getTime();

                // If the license just expired
                if (now > expiry) {
                    console.log(`License ${license.key} expired. Triggering message to ${license.domain}...`);

                    try {
                        // Send trigger message to WordPress Dashboard webhook
                        await fetch(license.webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                event: 'license_expired',
                                key: license.key,
                                message: 'Warning! Your theme license has expired. Security updates have been disabled.'
                            })
                        });

                        // Update status to expired so we don't spam them every day (unless we want to)
                        await db.ref(`licenses/${id}`).update({ status: 'expired' });
                        console.log(`Successfully notified ${license.domain}.`);
                    } catch (e) {
                        console.error(`Failed to trigger notification for ${license.domain}:`, e.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error in expiration cron:', err);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`License Manager Server running on port ${PORT}`);
});
