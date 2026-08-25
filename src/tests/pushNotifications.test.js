'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { DeviceToken } = require('../modules/notifications/deviceToken.model');
const { Notification } = require('../modules/notifications/notification.model');
const deviceTokenService = require('../modules/notifications/deviceToken.service');
const fcmService = require('../modules/notifications/fcm.service');
const notificationService = require('../modules/notifications/notification.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createGroup,
    createCustomer,
    ROLES,
} = require('./testHelpers');

const token = (char = 'a') => char.repeat(160);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate, attempts = 30) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for asynchronous notification delivery.');
};
const createPushUser = async () => {
    const group = await createGroup({ percentage: 0 });
    return createCustomer({ groupId: group._id });
};

let server;
let baseUrl;

const bearerFor = (user) => jwt.sign({ id: user._id.toString() }, config.jwt.secret, { expiresIn: '5m' });
const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, options);
    return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
    await connectTestDB();
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(async () => {
    fcmService.resetForTests();
    await clearCollections();
});

describe('authenticated Android FCM device registration', () => {
    it('rejects unauthenticated registration', async () => {
        const response = await request('/api/me/notifications/devices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: token(), platform: 'android', provider: 'fcm' }),
        });
        expect(response.status).toBe(401);
    });

    it('registers only the JWT user, ignores a supplied userId, and is idempotent', async () => {
        const owner = await createPushUser();
        const other = await createPushUser();
        const requestBody = { token: token(), platform: 'android', provider: 'fcm', userId: other._id.toString() };
        const options = {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(owner)}` },
            body: JSON.stringify(requestBody),
        };

        expect((await request('/api/me/notifications/devices', options)).status).toBe(200);
        expect((await request('/api/me/notifications/devices', options)).status).toBe(200);

        const devices = await DeviceToken.find({}).select('+token');
        expect(devices).toHaveLength(1);
        expect(String(devices[0].userId)).toBe(String(owner._id));
        expect(String(devices[0].userId)).not.toBe(String(other._id));
    });

    it('allows multiple devices and atomically moves a shared installation to the current account', async () => {
        const firstUser = await createPushUser();
        const secondUser = await createPushUser();
        const shared = token('b');
        await deviceTokenService.registerDeviceToken({ userId: firstUser._id, token: shared, platform: 'android', provider: 'fcm' });
        await deviceTokenService.registerDeviceToken({ userId: firstUser._id, token: token('c'), platform: 'android', provider: 'fcm' });
        await deviceTokenService.registerDeviceToken({ userId: secondUser._id, token: shared, platform: 'android', provider: 'fcm' });

        expect(await DeviceToken.countDocuments({ userId: firstUser._id, active: true })).toBe(1);
        expect(await DeviceToken.countDocuments({ userId: secondUser._id, active: true })).toBe(1);
        const reassigned = await DeviceToken.findOne({ token: shared }).select('+token');
        expect(String(reassigned.userId)).toBe(String(secondUser._id));
    });

    it('validates tokens and deactivates only the current user device on unregister', async () => {
        const owner = await createPushUser();
        const other = await createPushUser();
        const deviceToken = token('d');
        await deviceTokenService.registerDeviceToken({ userId: owner._id, token: deviceToken, platform: 'android', provider: 'fcm' });

        const invalid = await request('/api/me/notifications/devices', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(owner)}` },
            body: JSON.stringify({ token: 'too-short', platform: 'android', provider: 'fcm' }),
        });
        expect(invalid.status).toBe(422);

        const denied = await request('/api/me/notifications/devices', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(other)}` },
            body: JSON.stringify({ token: deviceToken }),
        });
        expect(denied.status).toBe(200);
        expect(denied.body.data.deactivated).toBe(false);
        expect((await DeviceToken.findOne({ token: deviceToken }).select('+token')).active).toBe(true);

        const own = await request('/api/me/notifications/devices', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(owner)}` },
            body: JSON.stringify({ token: deviceToken }),
        });
        expect(own.body.data.deactivated).toBe(true);
        expect((await DeviceToken.findOne({ token: deviceToken }).select('+token')).active).toBe(false);
    });
});

describe('FCM delivery boundary', () => {
    it('is disabled safely when Firebase credentials are absent', async () => {
        const previous = {
            project: process.env.FIREBASE_ADMIN_PROJECT_ID,
            email: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
            key: process.env.FIREBASE_ADMIN_PRIVATE_KEY,
            path: process.env.FIREBASE_ADMIN_CREDENTIALS_PATH,
        };
        delete process.env.FIREBASE_ADMIN_PROJECT_ID;
        delete process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
        delete process.env.FIREBASE_ADMIN_PRIVATE_KEY;
        delete process.env.FIREBASE_ADMIN_CREDENTIALS_PATH;
        fcmService.resetForTests();

        await expect(fcmService.sendPushToUser({ userId: '000000000000000000000001', payload: { title: 'N&A', body: 'x', data: {} } }))
            .resolves.toMatchObject({ enabled: false, sent: 0 });

        const restore = {
            FIREBASE_ADMIN_PROJECT_ID: previous.project,
            FIREBASE_ADMIN_CLIENT_EMAIL: previous.email,
            FIREBASE_ADMIN_PRIVATE_KEY: previous.key,
            FIREBASE_ADMIN_CREDENTIALS_PATH: previous.path,
        };
        Object.entries(restore).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
    });

    it('dispatches to active devices, handles partial failure, and deactivates invalid tokens', async () => {
        const user = await createPushUser();
        const valid = token('e');
        const invalid = token('f');
        await deviceTokenService.registerDeviceToken({ userId: user._id, token: valid, platform: 'android', provider: 'fcm' });
        await deviceTokenService.registerDeviceToken({ userId: user._id, token: invalid, platform: 'android', provider: 'fcm' });
        const messaging = {
            sendEachForMulticast: jest.fn().mockResolvedValue({
                successCount: 1,
                failureCount: 1,
                responses: [
                    { success: true },
                    { success: false, error: { code: 'messaging/registration-token-not-registered' } },
                ],
            }),
        };
        fcmService.setMessagingClientForTests(messaging);

        const result = await fcmService.sendPushToUser({
            userId: user._id,
            payload: { title: 'N&A', body: 'تم تحديث حالة طلبك', data: { type: 'order_status', route: '/orders' } },
        });

        expect(result).toMatchObject({ enabled: true, sent: 1, failed: 1, invalidTokens: 1 });
        expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
        expect((await DeviceToken.findOne({ token: invalid }).select('+token')).active).toBe(false);
        expect((await DeviceToken.findOne({ token: valid }).select('+token')).active).toBe(true);
    });

    it('sends one privacy-safe push for an integrated order event and none for unrelated notifications', async () => {
        const user = await createPushUser();
        await deviceTokenService.registerDeviceToken({ userId: user._id, token: token('g'), platform: 'android', provider: 'fcm' });
        const messaging = {
            sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] }),
        };
        fcmService.setMessagingClientForTests(messaging);

        await notificationService.notifyOrderCompleted({ userId: user._id, orderNumber: 'private-order-number' });
        await waitFor(() => messaging.sendEachForMulticast.mock.calls.length === 1);
        expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
        const message = messaging.sendEachForMulticast.mock.calls[0][0];
        expect(message.notification).toEqual({ title: 'N&A', body: 'تم تحديث حالة طلبك' });
        expect(message.data).toEqual({ type: 'order_status', route: '/orders' });
        expect(JSON.stringify(message)).not.toContain('private-order-number');

        await notificationService.notifyUser({
            userId: user._id,
            title: 'Internal admin note',
            message: 'Unrelated event',
        });
        await flush();
        expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
    });

    it('dispatches a sanitized manual-order push to every admin-review recipient', async () => {
        const admin = await createAdmin();
        const supervisor = await createAdmin({ role: ROLES.SUPERVISOR });
        const adminToken = token('h');
        const supervisorToken = token('i');
        await deviceTokenService.registerDeviceToken({ userId: admin._id, token: adminToken, platform: 'android', provider: 'fcm' });
        await deviceTokenService.registerDeviceToken({ userId: supervisor._id, token: supervisorToken, platform: 'android', provider: 'fcm' });
        const messaging = {
            sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] }),
        };
        fcmService.setMessagingClientForTests(messaging);

        const notifications = await notificationService.notifyNewManualOrder({
            orderNumber: 'private-order-number',
            userNameSnapshot: 'Private customer name',
            productNameSnapshot: 'Private product name',
        });

        expect(notifications).toHaveLength(2);
        expect(await Notification.countDocuments({ source: 'ORDER', link: '/admin/orders' })).toBe(2);
        await waitFor(() => messaging.sendEachForMulticast.mock.calls.length === 2);
        expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(2);

        const messages = messaging.sendEachForMulticast.mock.calls.map(([message]) => message);
        expect(messages.map((message) => message.tokens[0]).sort()).toEqual([adminToken, supervisorToken].sort());
        messages.forEach((message) => {
            expect(message.notification).toEqual({ title: 'طلب يدوي جديد', body: 'يوجد طلب جديد يحتاج إلى المتابعة' });
            expect(message.data).toEqual({ type: 'admin_order_created', route: '/admin/orders' });
            expect(JSON.stringify(message)).not.toContain('private-order-number');
            expect(JSON.stringify(message)).not.toContain('Private customer name');
            expect(JSON.stringify(message)).not.toContain('Private product name');
        });
    });

    it('keeps the manual-order in-app notifications when FCM delivery fails', async () => {
        const admin = await createAdmin();
        await deviceTokenService.registerDeviceToken({ userId: admin._id, token: token('j'), platform: 'android', provider: 'fcm' });
        const messaging = {
            sendEachForMulticast: jest.fn().mockRejectedValue(new Error('FCM unavailable')),
        };
        fcmService.setMessagingClientForTests(messaging);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const notifications = await notificationService.notifyNewManualOrder({});

        expect(notifications).toHaveLength(1);
        expect(await Notification.countDocuments({ userId: admin._id, source: 'ORDER', link: '/admin/orders' })).toBe(1);
        await waitFor(() => messaging.sendEachForMulticast.mock.calls.length === 1);
        errorSpy.mockRestore();
    });
});
