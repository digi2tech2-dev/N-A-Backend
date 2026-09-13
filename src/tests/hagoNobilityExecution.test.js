'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_STRATEGIES } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, HAGO_FINANCIAL_MUTATION_STATES } = require('../modules/orders/order.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('../modules/providers/hago/hagoProviderConnection.model');
const { HagoNobilityExecutionService } = require('../modules/providers/hago/hagoNobilityExecution.service');
const { HagoClientError } = require('../modules/providers/hago/hago.client');
const adminOrders = require('../modules/admin/admin.orders.service');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => clearCollections());

const unique = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

const createFixture = async ({ quoteRef = unique('quote_'), mutationState = HAGO_FINANCIAL_MUTATION_STATES.READY, status = ORDER_STATUS.PROCESSING, providerTransactionId = null } = {}) => {
    const provider = await Provider.create({ name: unique('Hago '), slug: 'hago', baseUrl: 'https://hago.invalid', isActive: true, syncInterval: 0 });
    const providerProduct = await ProviderProduct.create({ provider: provider._id, externalProductId: 'HAGO_NOBILITY_1', rawName: 'Knight', rawPrice: '0', minQty: 1, maxQty: 1, rawPayload: { metadata: { serviceType: 'NOBILITY', nobilityType: 1 } } });
    const product = await Product.create({ name: unique('Knight '), basePrice: '100', minQty: 1, maxQty: 1, provider: provider._id, providerProduct: providerProduct._id, pricingMode: 'manual', pricingStrategy: PRICING_STRATEGIES.HAGO_NOBILITY_READINESS, executionType: 'automatic', hagoNobilityPricing: { purchaseBasePrice: '100', renewalBasePrice: '50' } });
    const connection = await HagoProviderConnection.create({ provider: provider._id, connectionId: unique('con_'), isPrimary: true, enabled: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
    const order = await Order.create({
        userId: '64a000000000000000000001', productId: product._id, orderNumber: unique('HN').toUpperCase(),
        quantity: 1, unitPrice: '120', totalPrice: '120', basePriceSnapshot: '100', markupPercentageSnapshot: 20,
        finalPriceCharged: '120', groupIdSnapshot: '64a000000000000000000002', profitUsd: '20', walletDeducted: 120,
        creditUsedAmount: '0', currency: 'USD', rateSnapshot: 1, usdAmount: '120', chargedAmount: 120,
        status, executionType: 'automatic', providerCode: 'hago',
        hagoNobility: { serviceType: 'NOBILITY', quoteRef, selectedType: 1, selectedName: 'Knight', requestedTargetId: '51511', operation: 'PURCHASE', connectionRef: connection._id, providerMutationKey: `hago:nobility:${unique('order_')}`, mutationState, providerTransactionId },
    });
    return { provider, product, connection, order };
};

describe('Hago Nobility execution safety', () => {
    it('persists SENT and its server-generated key before the only mutation call', async () => {
        const { provider, order } = await createFixture();
        const send = jest.fn(async () => {
            const durable = await Order.findById(order._id).select('+hagoNobility.providerMutationKey');
            expect(durable.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.SENT);
            expect(durable.hagoNobility.providerMutationKey).toMatch(/^hago:nobility:/);
            return { statusCode: 200, data: { transaction: { id: 'tx_success', status: 'SUCCESS', upstreamStatus: 'SUCCESS' } } };
        });
        const service = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: send }), env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });

        await Promise.all([service.execute(order._id), service.execute(order._id)]);

        const stored = await Order.findById(order._id).select('+hagoNobility.providerMutationKey');
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: stored.hagoNobility.providerMutationKey }));
        expect(stored.status).toBe(ORDER_STATUS.COMPLETED);
        expect(String(provider._id)).toBeTruthy();
    });

    it('refunds an authoritative 409 rejection once and never permits generic retry', async () => {
        const { order } = await createFixture();
        const refund = jest.fn().mockResolvedValue(true);
        const service = new HagoNobilityExecutionService({
            adapterFactory: () => ({ executeControlledNobility: jest.fn().mockResolvedValue({ statusCode: 409, data: { transaction: { id: 'tx_rejected', status: 'FAILED', upstreamStatus: 'FAILED' } } }) }),
            refundFailedOrder: refund,
            env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' },
        });
        await service.execute(order._id);
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.FAILED);
        expect(stored.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.FAILED);
        expect(refund).toHaveBeenCalledTimes(1);
        await expect(adminOrders.retryOrder(order._id, '64a000000000000000000003')).rejects.toMatchObject({ code: 'HAGO_FINANCIAL_RETRY_NOT_SUPPORTED' });
    });

    it.each([
        ['HTTP 502', { statusCode: 502, data: { transaction: { status: 'UNKNOWN', upstreamStatus: 'UNKNOWN' } } }],
        ['HTTP 504', { statusCode: 504, data: { transaction: { status: 'UNKNOWN', upstreamStatus: 'UNKNOWN' } } }],
        ['malformed response', { statusCode: 200, data: { transaction: { nonsense: true } } }],
    ])('%s after send becomes UNKNOWN/MANUAL_REVIEW with no refund or resend', async (_name, response) => {
        const { order } = await createFixture();
        const send = jest.fn().mockResolvedValue(response);
        const refund = jest.fn();
        const service = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: send }), refundFailedOrder: refund, env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });
        await service.execute(order._id);
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(stored.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
        expect(refund).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('keeps a post-send network timeout in manual review without a refund or second send', async () => {
        const { order } = await createFixture();
        const send = jest.fn().mockRejectedValue(new HagoClientError('timeout', { code: 'HAGO_UPSTREAM_TIMEOUT' }));
        const refund = jest.fn();
        const service = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: send }), refundFailedOrder: refund, env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });
        await service.execute(order._id);
        await service.execute(order._id);
        expect((await Order.findById(order._id)).hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
        expect(refund).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('keeps HTTP 202 SEND_PENDING pending only with a transaction reference; otherwise it is manual review', async () => {
        const withReference = await createFixture();
        const pending = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: jest.fn().mockResolvedValue({ statusCode: 202, data: { transaction: { id: 'tx_pending', status: 'PENDING', upstreamStatus: 'SEND_PENDING' } } }) }), env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });
        await pending.execute(withReference.order._id);
        const pendingOrder = await Order.findById(withReference.order._id).select('+hagoNobility.providerTransactionId');
        expect(pendingOrder.status).toBe(ORDER_STATUS.PROCESSING);
        expect(pendingOrder.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.PENDING);
        expect(pendingOrder.hagoNobility.providerTransactionId).toBe('tx_pending');

        await clearCollections();
        const withoutReference = await createFixture();
        const ambiguous = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: jest.fn().mockResolvedValue({ statusCode: 202, data: { transaction: { status: 'PENDING', upstreamStatus: 'SEND_PENDING' } } }) }), env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });
        await ambiguous.execute(withoutReference.order._id);
        const unknownOrder = await Order.findById(withoutReference.order._id);
        expect(unknownOrder.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(unknownOrder.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
    });

    it('treats a pre-send resolution failure as NOT_SENT/FAILED and refunds without calling HAGO-BOT', async () => {
        const { connection, order } = await createFixture();
        await HagoProviderConnection.deleteOne({ _id: connection._id });
        const send = jest.fn();
        const refund = jest.fn().mockResolvedValue(true);
        const service = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: send }), refundFailedOrder: refund, env: { HAGO_NOBILITY_FULFILLMENT_ENABLED: 'true' } });
        await service.execute(order._id);
        const stored = await Order.findById(order._id);
        expect(stored.status).toBe(ORDER_STATUS.FAILED);
        expect(stored.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.FAILED);
        expect(send).not.toHaveBeenCalled();
        expect(refund).toHaveBeenCalledTimes(1);
    });

    it('reconciliation calls only transaction read/reconciliation APIs, never a Nobility mutation', async () => {
        const { order } = await createFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status: ORDER_STATUS.MANUAL_REVIEW, providerTransactionId: 'tx_unknown' });
        const client = {
            lookupTransaction: jest.fn().mockResolvedValue({ id: 'tx_unknown', status: 'UNKNOWN', upstreamStatus: 'UNKNOWN' }),
            reconcileTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
            nobilityRecharge: jest.fn(),
        };
        const mutation = jest.fn();
        const service = new HagoNobilityExecutionService({ client, adapterFactory: () => ({ executeControlledNobility: mutation }) });
        const result = await service.reconcile(order._id);
        expect(result.outcome).toBe('UNRESOLVED');
        expect(client.lookupTransaction).toHaveBeenCalledTimes(1);
        expect(client.reconcileTransaction).toHaveBeenCalledTimes(1);
        expect(client.nobilityRecharge).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
    });

    it('moves an unresolved pending operation to manual review after the bounded read-only attempts', async () => {
        const { order } = await createFixture({ mutationState: HAGO_FINANCIAL_MUTATION_STATES.PENDING, providerTransactionId: 'tx_pending_unknown' });
        await Order.updateOne({ _id: order._id }, { $set: { 'hagoNobility.reconciliationAttempts': 2 } });
        const client = {
            lookupTransaction: jest.fn().mockResolvedValue({ id: 'tx_pending_unknown', status: 'PENDING', upstreamStatus: 'SEND_PENDING' }),
            reconcileTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };
        const service = new HagoNobilityExecutionService({ client });
        const result = await service.reconcile(order._id);
        expect(result.outcome).toBe('UNRESOLVED');
        expect(result.order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(result.order.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN);
    });
});

describe('Hago Nobility quote uniqueness', () => {
    it('allows unlimited ordinary orders and makes a real Nobility quote unique', async () => {
        const first = await createFixture({ quoteRef: unique('quote_unique_') });
        const normal = {
            userId: '64a000000000000000000010', productId: first.product._id, quantity: 1, unitPrice: '1', totalPrice: '1',
            basePriceSnapshot: '1', markupPercentageSnapshot: 0, finalPriceCharged: '1', groupIdSnapshot: '64a000000000000000000011', walletDeducted: 1, creditUsedAmount: '0',
        };
        await Order.create({ ...normal, orderNumber: unique('ORD').toUpperCase() });
        await Order.create({ ...normal, orderNumber: unique('ORD').toUpperCase() });
        expect(await Order.countDocuments({ 'hagoNobility.quoteRef': { $exists: false } })).toBe(2);

        const duplicate = { ...first.order.toObject(), _id: undefined, orderNumber: unique('HN').toUpperCase() };
        delete duplicate.createdAt;
        delete duplicate.updatedAt;
        await expect(Order.create(duplicate)).rejects.toMatchObject({ code: 11000 });
    });
});
