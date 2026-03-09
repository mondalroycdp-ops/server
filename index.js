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
    });
});

// GET route to return expired licenses directly from server
app.get('/api/expired-licenses', async (req, res) => {
    try {
        const snapshot = await db.ref('licenses').once('value');
        if (!snapshot.exists()) {
            return res.json([]);
        }

        const allLicenses = snapshot.val();
        const expiredLicenses = [];

        for (const id in allLicenses) {
            // Note: Since you're continuously moving them to status:'expired', this array holds all of them
            if (allLicenses[id].status === 'expired') {
                expiredLicenses.push({
                    id,
                    ...allLicenses[id]
                });
            }
        }

        // Sort by most recently created
        expiredLicenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return res.json(expiredLicenses);
    } catch (error) {
        console.error('Error fetching expired licenses:', error);
        return res.status(500).json({ valid: false, message: 'Internal Server Error' });
    }
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

            // Trigger immediate status change and webhook notification if it wasn't expired already
            if (license.status !== 'expired') {
                await db.ref(`licenses/${licenseId}`).update({ status: 'expired' });
                console.log(`       Status updated to expired because time passed.`);

                if (license.webhookUrl) {
                    try {
                        await fetch(license.webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                event: 'license_expired',
                                key: license.key,
                                message: 'Warning! Your theme license has expired. Security updates have been disabled.'
                            })
                        });
                        console.log(`       Triggered immediate expiration webhook to: ${license.domain}`);
                    } catch (e) {
                        console.error(`       Failed to send expiry webhook:`, e.message);
                    }
                }
            }

            return res.status(403).json({
                valid: false,
                message: 'Your license key has expired. Please renew.',
                expiryDate: license.expiryDate
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

// CRON JOB: Runs every minute to continuously check for expired licenses
cron.schedule('* * * * *', async () => {
    console.log('Running continuous expiration check...');
    try {
        const snapshot = await db.ref('licenses').once('value');
        if (!snapshot.exists()) return;

        const licenses = snapshot.val();
        const now = new Date().getTime();

        for (const id in licenses) {
            const license = licenses[id];

            // Only process active licenses
            if (license.status === 'active') {
                const expiry = new Date(license.expiryDate).getTime();

                // If the license just expired in real-time
                if (now > expiry) {
                    console.log(`Server detected License ${license.key} expired. Updating status to expire...`);

                    // Update status immediately so Dashboard gets the Realtime Notification
                    await db.ref(`licenses/${id}`).update({ status: 'expired' });
                    console.log(`Successfully moved ${license.key} to expired state.`);

                    // If a WordPress webhook is configured, ping that as well
                    if (license.webhookUrl) {
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
                            console.log(`Successfully notified WordPress block to ${license.domain}.`);
                        } catch (e) {
                            console.error(`Failed to trigger notification for ${license.domain}:`, e.message);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error in continuous expiration cron:', err);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`License Manager Server running on port ${PORT}`);
});
