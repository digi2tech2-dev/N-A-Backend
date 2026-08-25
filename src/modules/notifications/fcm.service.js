'use strict';

const { getActiveTokensForUser, deactivateTokens } = require('./deviceToken.service');

const INVALID_TOKEN_CODES = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
]);

let messagingClient = null;
let initializationAttempted = false;
let testMessagingClient = null;

const configuredCredential = () => {
    const projectId = String(process.env.FIREBASE_ADMIN_PROJECT_ID || '').trim();
    const clientEmail = String(process.env.FIREBASE_ADMIN_CLIENT_EMAIL || '').trim();
    const privateKey = String(process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    const credentialPath = String(process.env.FIREBASE_ADMIN_CREDENTIALS_PATH || '').trim();
    return { projectId, clientEmail, privateKey, credentialPath };
};

const getMessagingClient = () => {
    if (testMessagingClient) return testMessagingClient;
    if (messagingClient || initializationAttempted) return messagingClient;
    initializationAttempted = true;

    const credentials = configuredCredential();
    const hasInlineCredential = credentials.projectId && credentials.clientEmail && credentials.privateKey;
    if (!hasInlineCredential && !credentials.credentialPath) return null;

    try {
        const { getApps, initializeApp, cert } = require('firebase-admin/app');
        const { getMessaging } = require('firebase-admin/messaging');
        const app = getApps()[0] || initializeApp(
            credentials.credentialPath
                ? { credential: cert(credentials.credentialPath) }
                : {
                    credential: cert({
                        projectId: credentials.projectId,
                        clientEmail: credentials.clientEmail,
                        privateKey: credentials.privateKey,
                    }),
                }
        );
        messagingClient = getMessaging(app);
    } catch (error) {
        // Never log credential values, token values, or the full Firebase error.
        console.error(`[FCM] initialization unavailable: ${String(error?.code || error?.message || 'unknown error')}`);
        messagingClient = null;
    }

    return messagingClient;
};

const chunk = (items, size) => {
    const batches = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
};

const sendPushToUser = async ({ userId, payload }) => {
    const client = getMessagingClient();
    if (!client) return { enabled: false, sent: 0, failed: 0, invalidTokens: 0 };

    const devices = await getActiveTokensForUser(userId);
    const tokens = devices.map((device) => device.token).filter(Boolean);
    if (!tokens.length) return { enabled: true, sent: 0, failed: 0, invalidTokens: 0 };

    let sent = 0;
    let failed = 0;
    const invalidTokens = [];

    for (const tokensBatch of chunk(tokens, 500)) {
        try {
            const response = await client.sendEachForMulticast({
                tokens: tokensBatch,
                notification: { title: payload.title, body: payload.body },
                data: payload.data,
                android: { priority: 'high' },
            });
            sent += Number(response.successCount || 0);
            failed += Number(response.failureCount || 0);
            (response.responses || []).forEach((item, index) => {
                if (!item.success && INVALID_TOKEN_CODES.has(item.error?.code)) invalidTokens.push(tokensBatch[index]);
            });
        } catch (error) {
            failed += tokensBatch.length;
            console.error(`[FCM] multicast delivery failed: ${String(error?.code || error?.message || 'unknown error')}`);
        }
    }

    if (invalidTokens.length) await deactivateTokens(invalidTokens);
    return { enabled: true, sent, failed, invalidTokens: invalidTokens.length };
};

// Test-only seam; production code never supplies a Firebase client here.
const setMessagingClientForTests = (client) => {
    if (process.env.NODE_ENV === 'test') testMessagingClient = client;
};

const resetForTests = () => {
    if (process.env.NODE_ENV !== 'test') return;
    messagingClient = null;
    initializationAttempted = false;
    testMessagingClient = null;
};

module.exports = { sendPushToUser, setMessagingClientForTests, resetForTests };
