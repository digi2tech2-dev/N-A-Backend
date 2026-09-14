'use strict';

const { InchillClient, InchillClientError } = require('../modules/providers/inchill/inchill.client');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { InchillProviderConnection } = require('../modules/providers/inchill/inchillProviderConnection.model');
const { InchillFinancialExecutionService } = require('../modules/providers/inchill/inchillFinancialExecution.service');
const { InchillConnectionService } = require('../modules/providers/inchill/inchillConnection.service');
const { createOrder } = require('../modules/orders/order.service');
const { inchillPreflightValidation } = require('../modules/products/product.validation');
const validate = require('../shared/middlewares/validate');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, freshUser } = require('./testHelpers');

const makeHttpClient = () => ({ post: jest.fn() });

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED = 'true';
});
afterAll(() => { delete process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED; });

const runValidation = async (body) => {
    const req = { body: { ...body }, params: { id: '64a000000000000000000003' }, method: 'POST', originalUrl: '/api/products/id/inchill/preflight' };
    const res = {};
    for (const middleware of inchillPreflightValidation) {
        await new Promise((resolve, reject) => {
            let settled = false;
            const done = (error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error); else resolve();
            };
            Promise.resolve(middleware(req, res, done)).then(() => done()).catch(done);
        });
    }
    try {
        validate(req, res, () => {});
        return { req, error: null };
    } catch (error) {
        return { req, error };
    }
};

describe('Customer Inchill preflight input boundary', () => {
    it('accepts and sanitizes exactly targetId and a positive finite amount', async () => {
        const { req, error } = await runValidation({ targetId: ' 51511 ', amount: 7 });
        expect(error).toBeNull();
        expect(req.body).toEqual({ targetId: '51511', amount: 7 });
    });

    it.each([
        ['agentPhone', '+201234567890'],
        ['serviceType', 'DIAMOND'],
        ['providerMutationKey', 'customer-key'],
        ['idempotencyKey', 'customer-key'],
        ['Idempotency-Key', 'customer-key'],
        ['connectionRef', '64a000000000000000000004'],
        ['providerId', '64a000000000000000000005'],
        ['apiKey', 'not-allowed'],
        ['internalApiKey', 'not-allowed'],
        ['session', 'not-allowed'],
        ['cookie', 'not-allowed'],
        ['token', 'not-allowed'],
    ])('rejects injected %s before the controller/service boundary', async (field, value) => {
        const { error } = await runValidation({ targetId: '51511', amount: 7, [field]: value });
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it.each([
        [{ targetId: '', amount: 7 }],
        [{ targetId: 51511, amount: 7 }],
        [{ targetId: '51511', amount: 0 }],
        [{ targetId: '51511', amount: -1 }],
        [{ targetId: '51511', amount: Infinity }],
        [{ targetId: '51511', amount: 'not-a-number' }],
    ])('rejects invalid target or amount input', async (body) => {
        const { error } = await runValidation(body);
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
});

describe('Inchill V1 server-side client contract', () => {
    it('sends the exact controlled Diamond request with only server-side credentials', async () => {
        const http = makeHttpClient();
        http.post.mockResolvedValue({ status: 200, data: { status: 'SUCCESS', transaction: { id: 'tx_1', status: 'SUCCESS', upstreamStatus: 'SUCCESS' } } });
        const client = new InchillClient({ apiKey: 'server-only-key', httpClient: http });

        const response = await client.rechargeDiamond('+201234567890', '51511', 7, 'inchill:order-1');

        expect(http.post).toHaveBeenCalledWith(
            '/api/bot/recharge/diamond',
            { agentPhone: '+201234567890', targetId: '51511', amount: 7 },
            { headers: { 'x-internal-api-key': 'server-only-key', 'Idempotency-Key': 'inchill:order-1', 'X-Controlled-Mutation': 'true' } }
        );
        expect(response.data.transaction.id).toBe('tx_1');
        expect(JSON.stringify(response)).not.toContain('server-only-key');
    });

    it('keeps a provider timeout safe and never carries a credential in the error', async () => {
        const http = makeHttpClient();
        const timeout = new Error('request failed with key server-only-key');
        timeout.code = 'ECONNABORTED';
        http.post.mockRejectedValue(timeout);
        const client = new InchillClient({ apiKey: 'server-only-key', httpClient: http });

        await expect(client.rechargePreflight('+201234567890', '51511', 7)).rejects.toMatchObject({
            name: 'InchillClientError', code: 'INCHILL_TIMEOUT',
        });
        await client.rechargePreflight('+201234567890', '51511', 7).catch((error) => {
            expect(error).toBeInstanceOf(InchillClientError);
            expect(error.message).not.toContain('server-only-key');
            expect(error).not.toHaveProperty('response');
        });
    });

    it('does not send a mutation header on read-only preflight', async () => {
        const http = makeHttpClient();
        http.post.mockResolvedValue({ status: 200, data: { status: 'SUCCESS', preflight: { readOnly: true } } });
        const client = new InchillClient({ apiKey: 'server-only-key', httpClient: http });

        await client.rechargePreflight('+201234567890', '51511', 7);

        const headers = http.post.mock.calls[0][2].headers;
        expect(headers).toEqual({ 'x-internal-api-key': 'server-only-key' });
        expect(headers).not.toHaveProperty('Idempotency-Key');
        expect(headers).not.toHaveProperty('X-Controlled-Mutation');
    });

    it('maps OTP requests and verification through the backend-only API key', async () => {
        const http = makeHttpClient();
        http.post.mockResolvedValue({ status: 200, data: { status: 'SUCCESS' } });
        const client = new InchillClient({ apiKey: 'server-only-key', httpClient: http });

        await client.sendOtp({ phone: '+201234567890', countryCode: '20', deviceId: 'device-123' });
        await client.verifyOtp({ phone: '+201234567890', otp: '123456', deviceId: 'device-123', country: 'EG', language: 'ar' });

        expect(http.post).toHaveBeenNthCalledWith(1, '/api/auth/send-otp', { phone: '+201234567890', countryCode: '20' }, { headers: { 'x-internal-api-key': 'server-only-key' } });
        expect(http.post).toHaveBeenNthCalledWith(2, '/api/auth/verify-otp', { phone: '+201234567890', otp: '123456', deviceId: 'device-123', country: 'EG', language: 'ar' }, { headers: { 'x-internal-api-key': 'server-only-key' } });
    });
});

describe('Inchill OTP connection lifecycle', () => {
    const createProvider = () => Provider.create({ name: `Inchill OTP ${Date.now()}-${Math.random()}`, slug: 'inchill', baseUrl: 'https://provider-record.example.invalid', isActive: true, syncInterval: 0 });
    const otpRequest = { phone: '+201234567890', countryCode: '20', deviceId: 'device-12345', country: 'eg', language: 'ar' };

    it('does not mark the connection CONNECTED until upstream OTP verification succeeds, then persists scoped metadata only', async () => {
        const provider = await createProvider();
        const client = { sendOtp: jest.fn().mockResolvedValue({ data: {} }), verifyOtp: jest.fn().mockResolvedValue({ data: {} }) };
        const service = new InchillConnectionService({ client });

        const sent = await service.sendOtp(provider._id, otpRequest);
        expect(client.sendOtp).toHaveBeenCalledWith({ ...otpRequest, country: 'EG' });
        expect(sent.connection).toMatchObject({ connectionStatus: 'OTP_PENDING', hasConnection: false });
        expect(JSON.stringify(sent)).not.toMatch(/agentPhone|device-12345|session|token/i);

        const verified = await service.verifyOtp(provider._id, { otp: '123456' });
        expect(client.verifyOtp).toHaveBeenCalledWith({ phone: '+201234567890', otp: '123456', deviceId: 'device-12345', country: 'EG', language: 'ar' });
        expect(verified.connection).toMatchObject({ connectionStatus: 'CONNECTED', hasConnection: true });
        expect(JSON.stringify(verified)).not.toMatch(/\+201234567890|device-12345|session|token/i);
        const stored = await InchillProviderConnection.findOne({ provider: provider._id }).select('+agentPhone');
        expect(stored).toMatchObject({ agentPhone: '+201234567890', countryCode: '20', country: 'EG', language: 'ar', connectionStatus: 'CONNECTED' });
    });

    it('rejects invalid and expired OTPs without calling the provider', async () => {
        const provider = await createProvider();
        const client = { sendOtp: jest.fn().mockResolvedValue({ data: {} }), verifyOtp: jest.fn() };
        const service = new InchillConnectionService({ client });
        await service.sendOtp(provider._id, otpRequest);
        await expect(service.verifyOtp(provider._id, { otp: 'bad' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(client.verifyOtp).not.toHaveBeenCalled();
        await InchillProviderConnection.updateOne({ provider: provider._id }, { $set: { 'pendingLogin.expiresAt': new Date(Date.now() - 1) } });
        await expect(service.verifyOtp(provider._id, { otp: '123456' })).rejects.toMatchObject({ code: 'INCHILL_OTP_EXPIRED' });
        expect(client.verifyOtp).not.toHaveBeenCalled();
    });

    it('does not create a pending connection when the provider is unavailable', async () => {
        const provider = await createProvider();
        const client = { sendOtp: jest.fn().mockRejectedValue(new InchillClientError('unavailable', { code: 'INCHILL_PROVIDER_UNAVAILABLE' })), verifyOtp: jest.fn() };
        const service = new InchillConnectionService({ client });

        await expect(service.sendOtp(provider._id, otpRequest)).rejects.toMatchObject({ code: 'INCHILL_PROVIDER_UNAVAILABLE' });
        expect(await InchillProviderConnection.findOne({ provider: provider._id })).toBeNull();
    });

    it('keeps an OTP-pending connection disconnected when OTP verification is unavailable', async () => {
        const provider = await createProvider();
        const client = { sendOtp: jest.fn().mockResolvedValue({ data: {} }), verifyOtp: jest.fn().mockRejectedValue(new InchillClientError('unavailable', { code: 'INCHILL_PROVIDER_UNAVAILABLE' })) };
        const service = new InchillConnectionService({ client });
        await service.sendOtp(provider._id, otpRequest);

        await expect(service.verifyOtp(provider._id, { otp: '123456' })).rejects.toMatchObject({ code: 'INCHILL_PROVIDER_UNAVAILABLE' });
        const stored = await InchillProviderConnection.findOne({ provider: provider._id }).select('+agentPhone');
        expect(stored.connectionStatus).toBe('OTP_PENDING');
        expect(stored.agentPhone).toBeNull();
    });

    it('persists a legacy UNKNOWN connection as CONNECTED after an authoritative connected session validation', async () => {
        const provider = await createProvider();
        const validatedAt = new Date('2026-09-14T10:00:00.000Z');
        await InchillProviderConnection.create({
            provider: provider._id,
            agentPhone: '+201234567890',
            isPrimary: true,
            enabled: true,
            connectionStatus: 'UNKNOWN',
            pendingLogin: { phone: '+201234567890', expiresAt: new Date('2026-09-14T10:10:00.000Z') },
        });
        const client = { validateSession: jest.fn().mockResolvedValue({ data: { session: { status: 'CONNECTED' } } }) };
        const service = new InchillConnectionService({ client, now: () => validatedAt });

        const validated = await service.validateSession(provider._id);
        const stored = await InchillProviderConnection.findOne({ provider: provider._id }).select('+pendingLogin.expiresAt');
        const serialized = await service.getConnection(provider._id);

        expect(validated.connection).toMatchObject({ connectionStatus: 'CONNECTED', lastValidationStatus: 'VALID', hasConnection: true });
        expect(stored).toMatchObject({ connectionStatus: 'CONNECTED', lastValidationStatus: 'VALID' });
        expect(stored.lastValidatedAt.getTime()).toBe(validatedAt.getTime());
        expect(stored.lastSuccessfulAt.getTime()).toBe(validatedAt.getTime());
        expect(stored.pendingLogin?.expiresAt).toBeUndefined();
        expect(serialized.connection).toMatchObject({ connectionStatus: 'CONNECTED', lastValidationStatus: 'VALID', hasConnection: true });
    });

    it('persists an authoritative reauthentication result without treating it as a connected session', async () => {
        const provider = await createProvider();
        await InchillProviderConnection.create({ provider: provider._id, agentPhone: '+201234567890', isPrimary: true, enabled: true, connectionStatus: 'UNKNOWN' });
        const service = new InchillConnectionService({ client: { validateSession: jest.fn().mockResolvedValue({ data: { session: { status: 'REAUTH_REQUIRED' } } }) } });

        const result = await service.validateSession(provider._id);
        const stored = await InchillProviderConnection.findOne({ provider: provider._id });

        expect(result).toMatchObject({ session: { status: 'REJECTED' }, connection: { connectionStatus: 'REAUTH_REQUIRED', lastValidationStatus: 'REJECTED' } });
        expect(stored).toMatchObject({ connectionStatus: 'REAUTH_REQUIRED', lastValidationStatus: 'REJECTED' });
    });

    it('keeps an ambiguous validation failure conservative and never marks a connection connected or disconnected', async () => {
        const provider = await createProvider();
        const lastSuccessfulAt = new Date('2026-09-13T10:00:00.000Z');
        await InchillProviderConnection.create({ provider: provider._id, agentPhone: '+201234567890', isPrimary: true, enabled: true, connectionStatus: 'UNKNOWN', lastSuccessfulAt });
        const service = new InchillConnectionService({ client: { validateSession: jest.fn().mockRejectedValue(new InchillClientError('timeout', { code: 'INCHILL_TIMEOUT' })) } });

        await expect(service.validateSession(provider._id)).rejects.toMatchObject({ code: 'INCHILL_TIMEOUT' });
        const stored = await InchillProviderConnection.findOne({ provider: provider._id });

        expect(stored).toMatchObject({ connectionStatus: 'UNKNOWN', lastValidationStatus: 'UNKNOWN' });
        expect(stored.lastSuccessfulAt.getTime()).toBe(lastSuccessfulAt.getTime());
    });
});

const fixture = async () => {
    const provider = await Provider.create({ name: `Inchill ${Date.now()}-${Math.random()}`, slug: 'inchill', baseUrl: 'https://provider-record.example.invalid', isActive: true, syncInterval: 0 });
    const connection = await InchillProviderConnection.create({ provider: provider._id, agentPhone: '+201234567890', isPrimary: true, enabled: true });
    const fingerprint = require('crypto').createHash('sha256').update(JSON.stringify({ providerId: String(provider._id), targetId: '51511', amount: 7, serviceType: 'DIAMOND' })).digest('hex');
    const service = new InchillFinancialExecutionService();
    const order = await Order.create({
        userId: '64a000000000000000000001', productId: '64a000000000000000000003', orderNumber: `IF${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        quantity: 7, unitPrice: '1', totalPrice: '1', basePriceSnapshot: '1', markupPercentageSnapshot: 0, finalPriceCharged: '1', groupIdSnapshot: '64a000000000000000000002', profitUsd: '0', walletDeducted: 1, creditUsedAmount: '0', currency: 'USD', rateSnapshot: 1, usdAmount: '1', chargedAmount: 1,
        status: ORDER_STATUS.PROCESSING, executionType: 'automatic', providerCode: 'inchill',
        inchillFinancial: service.buildOrderSnapshot({ provider, targetId: '51511', providerAmount: 7, connectionRef: connection._id, fingerprint }, `fixture-${Date.now()}-${Math.random()}`),
    });
    return { provider, connection, order };
};

const publishedDiamondFixture = async () => {
    const provider = await Provider.create({ name: `Inchill Published ${Date.now()}-${Math.random()}`, slug: 'inchill', baseUrl: 'https://provider-record.example.invalid', isActive: true, syncInterval: 0 });
    const providerProduct = await ProviderProduct.create({ provider: provider._id, externalProductId: 'INCHILL_DIAMOND_AMOUNT', rawName: 'Inchill Diamond', rawPrice: '0.0000146116138799', minQty: 1, maxQty: 999999999, isActive: true, rawPayload: { metadata: { serviceType: 'DIAMOND' } } });
    const product = await Product.create({ name: `Inchill Diamond ${Date.now()}-${Math.random()}`, basePrice: '0.0000146116138799', minQty: 1, maxQty: 999999999, isActive: true, executionType: 'automatic', pricingMode: 'manual', provider: provider._id, providerProduct: providerProduct._id, orderFields: [{ id: 'target', key: 'player_id', label: 'Player ID', type: 'text', required: true }] });
    return { provider, providerProduct, product };
};

describe('Inchill customer checkout contract', () => {
    it('accepts the published player_id target field and an authoritative CONNECTED preflight without a mutation', async () => {
        const { provider, product } = await publishedDiamondFixture();
        await InchillProviderConnection.create({ provider: provider._id, agentPhone: '+201234567890', isPrimary: true, enabled: true });
        const rechargeDiamond = jest.fn();
        const client = {
            validateSession: jest.fn().mockResolvedValue({ data: { session: { status: 'CONNECTED' } } }),
            verifyTarget: jest.fn().mockResolvedValue({ data: { userInfo: { vid: '376756346' } } }),
            rechargePreflight: jest.fn().mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'CONNECTED', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: true, target: { vid: '376756346' }, amount: 10 } } }),
            rechargeDiamond,
        };

        const prepared = await new InchillFinancialExecutionService({ client }).prepareNewOrder({
            product,
            quantity: 10,
            customerInput: { values: { player_id: '376756346' } },
        });

        expect(prepared).toMatchObject({ targetId: '376756346', providerAmount: 10 });
        expect(client.verifyTarget).toHaveBeenCalledWith('+201234567890', '376756346');
        expect(rechargeDiamond).not.toHaveBeenCalled();
    });

    it('rejects disabled checkout before wallet debit, order creation, or provider mutation', async () => {
        const { product } = await publishedDiamondFixture();
        const { customer } = await createCustomerWithGroup({ walletBalance: 25 });
        const balanceBefore = (await freshUser(customer._id)).walletBalance;
        delete process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED;

        try {
            await expect(createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 10,
                orderFieldsValues: { player_id: '376756346' },
            })).rejects.toMatchObject({
                statusCode: 422,
                code: 'INCHILL_FINANCIAL_CHECKOUT_NOT_ENABLED',
            });
        } finally {
            process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED = 'true';
        }

        const customerAfter = await freshUser(customer._id);
        expect(customerAfter.walletBalance).toBe(balanceBefore);
        await expect(Order.countDocuments({ userId: customer._id, productId: product._id })).resolves.toBe(0);
    });
});

describe('Inchill financial execution safety', () => {
    const readyClient = (rechargeDiamond) => ({
        validateSession: jest.fn().mockResolvedValue({ data: { session: { status: 'VALID' } } }),
        verifyTarget: jest.fn().mockResolvedValue({ data: { userInfo: { vid: '51511' } } }),
        rechargePreflight: jest.fn().mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'VALID', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: true, target: { vid: '51511' }, amount: 7 } } }),
        rechargeDiamond,
    });

    it('claims concurrent workers once and persists one server-generated mutation key', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockResolvedValue({ data: { transaction: { id: 'tx_1', status: 'SUCCESS', upstreamStatus: 'SUCCESS' } } });
        const service = new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder: jest.fn() });

        await Promise.all([service.execute(order._id), service.execute(order._id)]);

        const stored = await Order.findById(order._id).select('+inchillFinancial.providerMutationKey');
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
        expect(stored.status).toBe(ORDER_STATUS.COMPLETED);
        expect(stored.inchillFinancial.mutationState).toBe('SUCCESS');
        expect(stored.inchillFinancial.providerMutationKey).toMatch(/^inchill:/);
    });

    it('does not send a recharge when the explicit Inchill feature gate is disabled', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const refundFailedOrder = jest.fn().mockResolvedValue(true);
        delete process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED;

        await new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder }).execute(order._id);

        const stored = await Order.findById(order._id);
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).toHaveBeenCalledTimes(1);
        expect(stored.inchillFinancial.mutationState).toBe('FAILED');
        process.env.INCHILL_DIAMOND_FULFILLMENT_ENABLED = 'true';
    });

    it('fails and refunds before send when the fresh preflight is not safe', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const refundFailedOrder = jest.fn().mockResolvedValue(true);
        const client = readyClient(rechargeDiamond);
        client.rechargePreflight.mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'VALID', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: false, target: { vid: '51511' }, amount: 7 } } });

        await new InchillFinancialExecutionService({ client, refundFailedOrder }).execute(order._id);

        const stored = await Order.findById(order._id);
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).toHaveBeenCalledTimes(1);
        expect(stored.status).toBe(ORDER_STATUS.FAILED);
        expect(stored.inchillFinancial.mutationState).toBe('FAILED');
    });

    it('keeps a post-send timeout in manual review without a refund or resend', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'INCHILL_TIMEOUT' }));
        const refundFailedOrder = jest.fn();

        await new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder }).execute(order._id);

        const stored = await Order.findById(order._id);
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
        expect(refundFailedOrder).not.toHaveBeenCalled();
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.inchillFinancial.mutationState).toBe('UNKNOWN');
        expect(stored.inchillFinancial.unknownReason).toBe('TIMEOUT');
    });

    it.each([
        ['REJECTED', 'INCHILL_REAUTHENTICATION_REQUIRED'],
        ['UNKNOWN', 'INCHILL_SESSION_UNKNOWN'],
    ])('blocks %s sessions before target lookup, preflight, or mutation', async (status, expectedCode) => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const refundFailedOrder = jest.fn().mockResolvedValue(true);
        const client = readyClient(rechargeDiamond);
        client.validateSession.mockResolvedValue({ data: { session: { status } } });

        await new InchillFinancialExecutionService({ client, refundFailedOrder }).execute(order._id);

        const stored = await Order.findById(order._id);
        expect(client.verifyTarget).not.toHaveBeenCalled();
        expect(client.rechargePreflight).not.toHaveBeenCalled();
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).toHaveBeenCalledTimes(1);
        expect(stored.inchillFinancial.unknownReason).toBe(expectedCode);
    });

    it('fails safely before mutation when session validation throws', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const client = readyClient(rechargeDiamond);
        client.validateSession.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'INCHILL_TIMEOUT' }));

        await new InchillFinancialExecutionService({ client, refundFailedOrder: jest.fn().mockResolvedValue(true) }).execute(order._id);

        expect(client.verifyTarget).not.toHaveBeenCalled();
        expect(client.rechargePreflight).not.toHaveBeenCalled();
        expect(rechargeDiamond).not.toHaveBeenCalled();
    });

    it.each([
        ['session mismatch', (client) => client.rechargePreflight.mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'UNKNOWN', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: true, target: { vid: '51511' }, amount: 7 } } })],
        ['target mismatch', (client) => client.rechargePreflight.mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'VALID', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: true, target: { vid: 'other' }, amount: 7 } } })],
        ['amount mismatch', (client) => client.rechargePreflight.mockResolvedValue({ data: { preflight: { readOnly: true, mutationAttempted: false, session: 'VALID', targetResolved: true, serviceType: 'DIAMOND', walletSufficient: true, target: { vid: '51511' }, amount: 8 } } })],
    ])('does not mutate when the provider preflight has a %s', async (_label, arrange) => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const client = readyClient(rechargeDiamond);
        arrange(client);

        await new InchillFinancialExecutionService({ client, refundFailedOrder: jest.fn().mockResolvedValue(true) }).execute(order._id);

        expect(rechargeDiamond).not.toHaveBeenCalled();
    });

    it.each([
        ['-401', 'session reauthentication'],
        ['-76', 'transfer limit'],
        ['-999', 'generic provider rejection'],
    ])('records a confirmed FAILED/%s response, safely refunds once, and never resends (%s)', async (upstreamCode) => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockResolvedValue({ data: { transaction: { id: 'tx_failed', status: 'FAILED', upstreamStatus: 'FAILED', upstreamCode } } });
        const refundFailedOrder = jest.fn().mockResolvedValue(true);
        const service = new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder });

        await service.execute(order._id);
        await service.execute(order._id);

        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.FAILED);
        expect(stored.inchillFinancial.mutationState).toBe('FAILED');
        expect(stored.inchillFinancial.providerCode).toBe(upstreamCode);
        expect(refundFailedOrder).toHaveBeenCalledTimes(1);
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
    });

    it('keeps SEND_PENDING unresolved with no refund or retry', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockResolvedValue({ data: { transaction: { id: 'tx_pending', status: 'PENDING', upstreamStatus: 'SEND_PENDING' } } });
        const refundFailedOrder = jest.fn();
        const service = new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder });

        await service.execute(order._id);
        await service.execute(order._id);

        const stored = await Order.findById(order._id);
        expect(stored.inchillFinancial.mutationState).toBe('PENDING');
        expect(stored.status).toBe(ORDER_STATUS.PROCESSING);
        expect(refundFailedOrder).not.toHaveBeenCalled();
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['NOT_SENT', { transaction: { id: 'tx_not_sent', status: 'FAILED', upstreamStatus: 'NOT_SENT' } }, 'NOT_SENT'],
        ['timeout result', { transaction: { id: 'tx_timeout', status: 'FAILED', upstreamStatus: 'UNKNOWN', upstreamTimeout: true } }, 'TIMEOUT'],
        ['malformed post-send response', { transaction: {} }, 'UNKNOWN'],
    ])('moves post-send %s to UNKNOWN manual review without a refund or retry', async (_label, data, reason) => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockResolvedValue({ data });
        const refundFailedOrder = jest.fn();
        const service = new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder });

        await service.execute(order._id);
        await service.execute(order._id);

        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.inchillFinancial.mutationState).toBe('UNKNOWN');
        expect(stored.inchillFinancial.unknownReason).toBe(reason);
        expect(refundFailedOrder).not.toHaveBeenCalled();
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
    });

    it('moves a post-send transport failure to UNKNOWN manual review with no refund or retry', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn().mockRejectedValue(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
        const refundFailedOrder = jest.fn();
        const service = new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder });

        await service.execute(order._id);
        await service.execute(order._id);

        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.inchillFinancial.unknownReason).toBe('MUTATION_TRANSPORT');
        expect(refundFailedOrder).not.toHaveBeenCalled();
        expect(rechargeDiamond).toHaveBeenCalledTimes(1);
    });

    it.each(['CLAIMED', 'SENT', 'PENDING', 'UNKNOWN', 'SUCCESS', 'FAILED'])('never sends again from the persisted %s state', async (mutationState) => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        await Order.updateOne({ _id: order._id }, { $set: { 'inchillFinancial.mutationState': mutationState } });

        await new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder: jest.fn() }).execute(order._id);

        expect(rechargeDiamond).not.toHaveBeenCalled();
    });

    it('fails closed on a persisted intent fingerprint mismatch without mutation or refund', async () => {
        const { order } = await fixture();
        const rechargeDiamond = jest.fn();
        const refundFailedOrder = jest.fn();
        await Order.updateOne({ _id: order._id }, { $set: { 'inchillFinancial.intentFingerprint': 'tampered' } });

        await new InchillFinancialExecutionService({ client: readyClient(rechargeDiamond), refundFailedOrder }).execute(order._id);

        const stored = await Order.findById(order._id);
        expect(stored.inchillFinancial.mutationState).toBe('UNKNOWN');
        expect(stored.inchillFinancial.unknownReason).toBe('FINGERPRINT_MISMATCH');
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).not.toHaveBeenCalled();
    });

    it('reconciles only an attempted UNKNOWN transaction using its stored provider transaction ID and never mutates or refunds', async () => {
        const { order } = await fixture();
        await Order.updateOne({ _id: order._id }, { $set: { status: ORDER_STATUS.MANUAL_REVIEW, 'inchillFinancial.mutationState': 'UNKNOWN', 'inchillFinancial.providerStatus': 'UNKNOWN', 'inchillFinancial.providerTransactionId': 'tx_reconcile' } });
        const rechargeDiamond = jest.fn();
        const reconcileRecharge = jest.fn().mockResolvedValue({ data: { reconciliation: { outcome: 'UNKNOWN', wallet: { diamond: 1 }, history: [] } } });
        const refundFailedOrder = jest.fn();
        const service = new InchillFinancialExecutionService({ client: { ...readyClient(rechargeDiamond), reconcileRecharge }, refundFailedOrder });

        await expect(service.reconcile(order._id, { from: '2026-01-01' })).resolves.toMatchObject({ outcome: 'UNKNOWN' });
        const stored = await Order.findById(order._id);
        expect(reconcileRecharge).toHaveBeenCalledWith('+201234567890', 'tx_reconcile', { from: '2026-01-01' });
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).not.toHaveBeenCalled();
        expect(stored.inchillFinancial.mutationState).toBe('UNKNOWN');
        expect(stored.inchillFinancial.reconciliationAttempts).toBe(1);
    });

    it('rejects reconciliation without authoritative unresolved evidence and cannot change the financial outcome', async () => {
        const { order } = await fixture();
        const client = { ...readyClient(jest.fn()), reconcileRecharge: jest.fn() };
        const service = new InchillFinancialExecutionService({ client, refundFailedOrder: jest.fn() });
        await expect(service.reconcile(order._id)).rejects.toMatchObject({ code: 'INCHILL_RECONCILIATION_NOT_APPLICABLE' });
        expect(client.reconcileRecharge).not.toHaveBeenCalled();
    });

    it('does not settle an UNKNOWN order from a non-authoritative reconciliation response', async () => {
        const { order } = await fixture();
        await Order.updateOne({ _id: order._id }, { $set: { status: ORDER_STATUS.MANUAL_REVIEW, 'inchillFinancial.mutationState': 'UNKNOWN', 'inchillFinancial.providerStatus': 'UNKNOWN', 'inchillFinancial.providerTransactionId': 'tx_reconcile' } });
        const reconcileRecharge = jest.fn().mockResolvedValue({ data: { reconciliation: { outcome: 'SUCCESS' } } });
        const rechargeDiamond = jest.fn();
        const refundFailedOrder = jest.fn();
        const service = new InchillFinancialExecutionService({ client: { ...readyClient(rechargeDiamond), reconcileRecharge }, refundFailedOrder });

        await expect(service.reconcile(order._id)).rejects.toMatchObject({ code: 'INCHILL_RECONCILIATION_UNAVAILABLE' });
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.inchillFinancial.mutationState).toBe('UNKNOWN');
        expect(rechargeDiamond).not.toHaveBeenCalled();
        expect(refundFailedOrder).not.toHaveBeenCalled();
    });
});
