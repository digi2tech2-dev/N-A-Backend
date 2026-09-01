'use strict';

jest.mock('axios');

const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, HAGO_FINANCIAL_MUTATION_STATES } = require('../modules/orders/order.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('../modules/providers/hago/hagoProviderConnection.model');
const { HagoClient, HagoClientError } = require('../modules/providers/hago/hago.client');
const {
    HagoFinancialExecutionService,
    classifyHagoMutation,
    getTrustedTargetId,
    HAGO_FINANCIAL_UNKNOWN_REASONS,
} = require('../modules/providers/hago/hagoFinancialExecution.service');
const adminOrders = require('../modules/admin/admin.orders.service');
const { BusinessRuleError } = require('../shared/errors/AppError');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    jest.clearAllMocks();
    process.env.HAGO_DIAMOND_FULFILLMENT_ENABLED = 'true';
    process.env.HAGO_CRYSTAL_FULFILLMENT_ENABLED = 'true';
});
afterAll(() => {
    delete process.env.HAGO_DIAMOND_FULFILLMENT_ENABLED;
    delete process.env.HAGO_CRYSTAL_FULFILLMENT_ENABLED;
});

const makeHttpClient = () => ({ post: jest.fn(), get: jest.fn() });

const createHagoOrderFixture = async ({ serviceType = 'DIAMOND', mutationState = HAGO_FINANCIAL_MUTATION_STATES.READY, status = ORDER_STATUS.PROCESSING, providerTransactionId = null } = {}) => {
    const provider = await Provider.create({ name: `Hago ${Date.now()}-${Math.random()}`, slug: 'hago', baseUrl: 'https://hago.example.invalid', isActive: true, syncInterval: 0 });
    const externalProductId = serviceType === 'DIAMOND' ? 'HAGO_DIAMOND_AMOUNT' : 'HAGO_CRYSTAL_AMOUNT';
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId,
        rawName: `Hago ${serviceType}`,
        rawPrice: '0',
        minQty: 1,
        maxQty: null,
        rawPayload: { serviceType, amountMode: 'dynamic' },
    });
    const product = await Product.create({
        name: `Hago ${serviceType} Product ${Date.now()}-${Math.random()}`,
        basePrice: '1', minQty: 1, maxQty: 1000,
        provider: provider._id, providerProduct: providerProduct._id,
        pricingMode: 'manual', executionType: 'automatic',
        orderFields: [{ id: 'target', label: 'Hago ID', key: 'target_id', type: 'text', required: true, isActive: true }],
    });
    const connection = await HagoProviderConnection.create({
        provider: provider._id, connectionId: `con_${Math.random().toString(36).slice(2)}`,
        isPrimary: true, enabled: true, connectionStatus: CONNECTION_STATUS.CONNECTED,
    });
    const order = await Order.create({
        userId: '64a000000000000000000001', productId: product._id,
        orderNumber: `HF${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        quantity: 7, unitPrice: '1', totalPrice: '1', basePriceSnapshot: '1', markupPercentageSnapshot: 0,
        finalPriceCharged: '1', groupIdSnapshot: '64a000000000000000000002', profitUsd: '0',
        walletDeducted: 1, creditUsedAmount: '0', currency: 'USD', rateSnapshot: 1, usdAmount: '1', chargedAmount: 1,
        status, executionType: 'automatic', providerCode: 'hago',
        customerInput: { values: { target_id: '51511' }, fieldsSnapshot: [] },
        hagoFinancial: {
            serviceType, requestedTargetId: '51511', providerAmount: 7,
            connectionRef: connection._id, providerMutationKey: `hago:${serviceType.toLowerCase()}:${new Date().getTime()}-${Math.random()}`,
            mutationState, providerTransactionId,
        },
    });
    return { provider, providerProduct, product, connection, order };
};

describe('Hago V2 controlled Diamond/Crystal client contract', () => {
    it('uses only x-client-api-key plus required controlled/idempotency headers', async () => {
        const httpClient = makeHttpClient();
        httpClient.post.mockResolvedValue({ status: 200, data: { status: 'SUCCESS', transaction: { id: 'tx', status: 'SUCCESS', upstreamStatus: 'SUCCESS' } } });
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });
        await client.diamondRecharge('con_safe', { targetId: '51511', amount: 7, idempotencyKey: 'hago:diamond:order-1' });
        expect(httpClient.post).toHaveBeenCalledWith(
            '/api/v2/connections/con_safe/auto-recharge/diamond',
            { targetId: '51511', amount: 7 },
            { headers: { 'x-client-api-key': 'server-only-key', 'Idempotency-Key': 'hago:diamond:order-1', 'X-Controlled-Mutation': 'true' } }
        );
        expect(httpClient.post.mock.calls[0][2].headers).not.toHaveProperty('x-internal-api-key');
    });

    it.each([502, 503, 504])('keeps a %i response sanitized for UNKNOWN classification', async (statusCode) => {
        const httpClient = makeHttpClient();
        httpClient.post.mockRejectedValue({ response: { status: statusCode, data: { status: 'ERROR', transaction: { status: 'UNKNOWN', upstreamStatus: 'UNKNOWN' }, headers: { authorization: 'secret' } } } });
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });
        const response = await client.crystalRecharge('con_safe', { targetId: '51511', amount: 7, idempotencyKey: 'hago:crystal:order-1' });
        expect(response.statusCode).toBe(statusCode);
        expect(JSON.stringify(response)).not.toContain('secret');
        expect(classifyHagoMutation(response).outcome).toBe('UNKNOWN');
    });

    it('normalizes an ECONNRESET without leaking the API key', async () => {
        const httpClient = makeHttpClient();
        const error = new Error('socket reset key=server-only-key'); error.code = 'ECONNRESET';
        httpClient.post.mockRejectedValue(error);
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });
        await expect(client.diamondRecharge('con_safe', { targetId: '51511', amount: 7, idempotencyKey: 'hago:diamond:order-1' }))
            .rejects.toMatchObject({ code: 'HAGO_REQUEST_FAILED' });
        try { await client.diamondRecharge('con_safe', { targetId: '51511', amount: 7, idempotencyKey: 'hago:diamond:order-1' }); } catch (caught) {
            expect(caught.message).not.toContain('server-only-key');
            expect(caught).not.toHaveProperty('response');
        }
    });
});

describe('Hago financial execution safety', () => {
    it('claims concurrent Diamond workers once and persists one stable key before one send', async () => {
        const { provider, order } = await createHagoOrderFixture();
        const adapter = { executeControlledRecharge: jest.fn().mockResolvedValue({ statusCode: 200, data: { status: 'SUCCESS', transaction: { id: 'txn_diamond', status: 'SUCCESS', upstreamStatus: 'SUCCESS' } } }) };
        const service = new HagoFinancialExecutionService({ adapterFactory: () => adapter, refundFailedOrder: jest.fn() });
        await Promise.all([service.execute(order._id), service.execute(order._id)]);
        const stored = await Order.findById(order._id).select('+hagoFinancial.providerMutationKey +hagoFinancial.providerTransactionId');
        expect(adapter.executeControlledRecharge).toHaveBeenCalledTimes(1);
        expect(adapter.executeControlledRecharge).toHaveBeenCalledWith(expect.objectContaining({
            serviceType: 'DIAMOND', amount: 7, targetId: '51511', idempotencyKey: stored.hagoFinancial.providerMutationKey,
        }));
        expect(stored.hagoFinancial.providerMutationKey).toMatch(/^hago:diamond:/);
        expect(stored.status).toBe(ORDER_STATUS.COMPLETED);
        expect(stored.hagoFinancial.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.SUCCESS);
        expect(String(provider._id)).toBeTruthy();
    });

    it.each(['DIAMOND', 'CRYSTAL'])('%s authoritative failure refunds exactly once', async (serviceType) => {
        const { order } = await createHagoOrderFixture({ serviceType });
        const refund = jest.fn().mockResolvedValue(true);
        const service = new HagoFinancialExecutionService({
            adapterFactory: () => ({ executeControlledRecharge: jest.fn().mockResolvedValue({ statusCode: 409, data: { status: 'ERROR', transaction: { id: 'txn_failed', status: 'FAILED', upstreamStatus: 'FAILED' } } }) }),
            refundFailedOrder: refund,
        });
        await service.execute(order._id);
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.FAILED);
        expect(stored.hagoFinancial.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.FAILED);
        expect(refund).toHaveBeenCalledTimes(1);
    });

    it.each([
        'DIAMOND',
        'CRYSTAL',
    ])('%s rejects checkout before a wallet debit when its N&A gate is disabled', async (serviceType) => {
        const { product } = await createHagoOrderFixture({ serviceType });
        const env = {
            HAGO_DIAMOND_FULFILLMENT_ENABLED: 'false',
            HAGO_CRYSTAL_FULFILLMENT_ENABLED: 'false',
        };
        const client = { verifyTarget: jest.fn() };
        const service = new HagoFinancialExecutionService({ env, client });
        await expect(service.prepareNewOrder({ product, quantity: 7, customerInput: { values: { target_id: '51511' } } }))
            .rejects.toMatchObject({ code: 'HAGO_FINANCIAL_CHECKOUT_NOT_ENABLED' });
        expect(client.verifyTarget).not.toHaveBeenCalled();
    });

    it.each([
        ['timeout', new HagoClientError('timeout', { code: 'HAGO_UPSTREAM_TIMEOUT' })],
        ['502', new HagoClientError('unavailable', { code: 'HAGO_UPSTREAM_UNAVAILABLE', statusCode: 502 })],
        ['503', new HagoClientError('unavailable', { code: 'HAGO_UPSTREAM_UNAVAILABLE', statusCode: 503 })],
        ['504', new HagoClientError('timeout', { code: 'HAGO_UPSTREAM_TIMEOUT', statusCode: 504 })],
        ['ECONNRESET', Object.assign(new Error('socket'), { code: 'ECONNRESET' })],
        ['malformed', null],
    ])('Diamond and Crystal %s outcomes become UNKNOWN/MANUAL_REVIEW without refund or resend', async (_name, failure) => {
        const { order } = await createHagoOrderFixture({ serviceType: 'CRYSTAL' });
        const send = jest.fn();
        if (failure) send.mockRejectedValue(failure);
        else send.mockResolvedValue({ statusCode: 200, data: { status: 'SUCCESS', transaction: { nonsense: true } } });
        const refund = jest.fn();
        const service = new HagoFinancialExecutionService({ adapterFactory: () => ({ executeControlledRecharge: send }), refundFailedOrder: refund });
        await service.execute(order._id);
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.hagoFinancial.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
        expect(refund).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('Diamond timeout is also UNKNOWN with no refund and no repeat send', async () => {
        const { order } = await createHagoOrderFixture({ serviceType: 'DIAMOND' });
        const send = jest.fn().mockRejectedValue(new HagoClientError('timeout', { code: 'HAGO_UPSTREAM_TIMEOUT' }));
        const refund = jest.fn();
        const service = new HagoFinancialExecutionService({ adapterFactory: () => ({ executeControlledRecharge: send }), refundFailedOrder: refund });
        await service.execute(order._id);
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.hagoFinancial.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
        expect(refund).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('reconciles only recorded transaction evidence and leaves unresolved records manual-review', async () => {
        const { order } = await createHagoOrderFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status: ORDER_STATUS.MANUAL_REVIEW, providerTransactionId: 'txn_unknown' });
        const client = {
            lookupTransaction: jest.fn().mockResolvedValue({ id: 'txn_unknown', status: 'UNKNOWN', upstreamStatus: 'UNKNOWN' }),
            reconcileTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', reconciliation: { status: 'MANUAL_REVIEW_REQUIRED' } }),
        };
        const service = new HagoFinancialExecutionService({ client, adapterFactory: jest.fn(), refundFailedOrder: jest.fn() });
        const result = await service.reconcile(order._id);
        expect(result.outcome).toBe('UNRESOLVED');
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.refunded).toBe(false);
        expect(client.lookupTransaction).toHaveBeenCalledTimes(1);
        expect(client.reconcileTransaction).toHaveBeenCalledTimes(1);
    });

    it('settles a reconciliation-confirmed SUCCESS exactly once', async () => {
        const { order } = await createHagoOrderFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status: ORDER_STATUS.MANUAL_REVIEW, providerTransactionId: 'txn_success' });
        const client = {
            lookupTransaction: jest.fn().mockResolvedValue({ id: 'txn_success', status: 'SUCCESS', upstreamStatus: 'SUCCESS' }),
            reconcileTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };
        const service = new HagoFinancialExecutionService({ client, refundFailedOrder: jest.fn() });
        const result = await service.reconcile(order._id);
        expect(result.outcome).toBe('SUCCESS');
        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.COMPLETED);
    });

    it('settles a reconciliation-confirmed FAILED result with one refund', async () => {
        const { order } = await createHagoOrderFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status: ORDER_STATUS.MANUAL_REVIEW, providerTransactionId: 'txn_failed' });
        const refund = jest.fn().mockResolvedValue(true);
        const client = {
            lookupTransaction: jest.fn().mockResolvedValue({ id: 'txn_failed', status: 'FAILED', upstreamStatus: 'FAILED' }),
            reconcileTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };
        const service = new HagoFinancialExecutionService({ client, refundFailedOrder: refund });
        const result = await service.reconcile(order._id);
        expect(result.outcome).toBe('FAILED');
        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.FAILED);
        expect(refund).toHaveBeenCalledTimes(1);
    });

    it('never permits generic retry/refund for unresolved Hago financial orders', async () => {
        const { order } = await createHagoOrderFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status: ORDER_STATUS.MANUAL_REVIEW, providerTransactionId: 'txn_unknown' });
        await expect(adminOrders.retryOrder(order._id, '64a000000000000000000003')).rejects.toMatchObject({ code: 'HAGO_FINANCIAL_RETRY_NOT_SUPPORTED' });
        await expect(adminOrders.refundOrder(order._id, '64a000000000000000000003')).rejects.toMatchObject({ code: 'HAGO_FINANCIAL_RECONCILIATION_REQUIRED' });
    });
});

describe('Hago input authority', () => {
    it('requires one target from product-owned fields and does not accept financial fields from the browser', () => {
        expect(getTrustedTargetId({ targetId: '51511', amount: '9999', connectionId: 'forbidden' })).toBe('51511');
        expect(getTrustedTargetId({ target_uid: '51511', amount: '9999', connectionId: 'forbidden' })).toBe('51511');
        expect(() => getTrustedTargetId({ amount: 7, connectionId: 'forbidden' })).toThrow(BusinessRuleError);
    });

    it('classifies a V2 NOT_SENT rejection as authoritative no-send failure', () => {
        expect(classifyHagoMutation({ data: { transaction: { status: 'UNKNOWN', upstreamStatus: 'NOT_SENT' } } }).outcome).toBe('AUTHORITATIVE_FAILED');
        expect(HAGO_FINANCIAL_UNKNOWN_REASONS.UPSTREAM_UNKNOWN).toBe('UPSTREAM_UNKNOWN');
    });
});
