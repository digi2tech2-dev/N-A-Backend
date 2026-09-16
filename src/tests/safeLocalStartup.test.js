'use strict';

const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');

describe('safe local startup controls', () => {
    test('only skips the default settings seed when safe local mode is explicitly true', async () => {
        const seed = jest.fn().mockResolvedValue();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();

        expect(startDefaultSettingsSeed({ safeLocalProductionMode: false, seed })).toBe(true);
        await Promise.resolve();
        expect(seed).toHaveBeenCalledTimes(1);
    });

    test('configuration treats only lowercase true as safe local mode', () => {
        const original = process.env.SAFE_LOCAL_PRODUCTION_MODE;
        try {
            jest.resetModules();
            process.env.SAFE_LOCAL_PRODUCTION_MODE = 'TRUE';
            expect(require('../config/config').safeLocalProductionMode).toBe(false);
            jest.resetModules();
            process.env.SAFE_LOCAL_PRODUCTION_MODE = 'true';
            expect(require('../config/config').safeLocalProductionMode).toBe(true);
        } finally {
            if (original === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
            else process.env.SAFE_LOCAL_PRODUCTION_MODE = original;
            jest.resetModules();
        }
    });

    test('safe local startup never starts schedulers or WhatsApp, while independent flags retain their own gates', async () => {
        const originalOn = process.on;
        const run = async (config) => {
            jest.resetModules();
            const app = { listen: jest.fn((_, callback) => { callback(); return { close: jest.fn() }; }) };
            const connectDB = jest.fn().mockResolvedValue();
            const fulfillment = { start: jest.fn(), stop: jest.fn() };
            const sync = { start: jest.fn(), stop: jest.fn() };
            const whatsapp = { initializeWhatsAppClient: jest.fn().mockResolvedValue(), destroyWhatsAppClient: jest.fn().mockResolvedValue() };
            jest.doMock('../app', () => app);
            jest.doMock('../config/config', () => ({ env: 'test', port: 0, ...config }));
            jest.doMock('../config/database', () => connectDB);
            jest.doMock('../modules/orders/fulfillmentJob', () => fulfillment);
            jest.doMock('../modules/providers/syncProvidersJob', () => sync);
            jest.doMock('../modules/whatsapp/whatsapp.service', () => whatsapp);
            process.on = jest.fn();
            require('../server');
            await new Promise((resolve) => setImmediate(resolve));
            return { app, connectDB, fulfillment, sync, whatsapp };
        };
        try {
            let result = await run({ safeLocalProductionMode: true, backgroundJobsEnabled: true, whatsappAutoInit: true });
            expect(result.connectDB).toHaveBeenCalled();
            expect(result.app.listen).toHaveBeenCalled();
            expect(result.fulfillment.start).not.toHaveBeenCalled();
            expect(result.sync.start).not.toHaveBeenCalled();
            expect(result.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();

            result = await run({ safeLocalProductionMode: false, backgroundJobsEnabled: false, whatsappAutoInit: false });
            expect(result.fulfillment.start).not.toHaveBeenCalled();
            expect(result.sync.start).not.toHaveBeenCalled();
            expect(result.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();

            result = await run({ safeLocalProductionMode: false, backgroundJobsEnabled: true, whatsappAutoInit: true });
            expect(result.fulfillment.start).toHaveBeenCalledTimes(1);
            expect(result.sync.start).toHaveBeenCalledTimes(1);
            expect(result.whatsapp.initializeWhatsAppClient).toHaveBeenCalledTimes(1);
        } finally {
            process.on = originalOn;
            jest.resetModules();
            jest.dontMock('../app'); jest.dontMock('../config/config'); jest.dontMock('../config/database');
            jest.dontMock('../modules/orders/fulfillmentJob'); jest.dontMock('../modules/providers/syncProvidersJob'); jest.dontMock('../modules/whatsapp/whatsapp.service');
        }
    });

    test('safe local makes email transport creation a no-op', async () => {
        jest.resetModules();
        const createTransport = jest.fn();
        jest.doMock('../config/config', () => ({ env: 'production', safeLocalProductionMode: true, email: {} }));
        jest.doMock('nodemailer', () => ({ createTransport }));
        const { sendEmail } = require('../services/email.service');
        await sendEmail({ to: 'test@example.invalid', subject: 'test', html: '<b>test</b>' });
        expect(createTransport).not.toHaveBeenCalled();
        jest.dontMock('../config/config'); jest.dontMock('nodemailer'); jest.resetModules();
    });

    test('safe local makes WhatsApp admin sends a no-op before any client send', async () => {
        jest.resetModules();
        const sendMessage = jest.fn();
        jest.doMock('../config/config', () => ({ safeLocalProductionMode: true, whatsapp: {} }));
        jest.doMock('whatsapp-web.js', () => ({ Client: jest.fn(() => ({ sendMessage })), LocalAuth: jest.fn() }));
        const whatsapp = require('../modules/whatsapp/whatsapp.service');
        await expect(whatsapp.sendAdminNotification('test')).resolves.toBeNull();
        expect(sendMessage).not.toHaveBeenCalled();
        jest.dontMock('../config/config'); jest.dontMock('whatsapp-web.js'); jest.resetModules();
    });

    test('safe local makes FCM sends a no-op before Firebase messaging', async () => {
        jest.resetModules();
        const sendEachForMulticast = jest.fn();
        jest.doMock('../config/config', () => ({ safeLocalProductionMode: true, firebase: {} }));
        const fcm = require('../modules/notifications/fcm.service');
        fcm.setMessagingClientForTests({ sendEachForMulticast });
        await expect(fcm.sendPushToUser({ userId: '000000000000000000000000', payload: { title: 'test', body: 'test', data: {} } }))
            .resolves.toEqual({ enabled: false, sent: 0, failed: 0, invalidTokens: 0 });
        expect(sendEachForMulticast).not.toHaveBeenCalled();
        fcm.resetForTests(); jest.dontMock('../config/config'); jest.resetModules();
    });
});
