'use strict';

const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { User } = require('../modules/users/user.model');
const {
    createOrder,
} = require('../modules/orders/order.service');
const {
    executeOrder,
    refundFailedOrder,
    pollProcessingOrders,
} = require('../modules/orders/orderFulfillment.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
    freshUser,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const uniqueOrderNumber = () => `P1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createProcessingOrder = async ({
    customer,
    group,
    providerCode,
    providerOrderId = 'provider-order-1',
    quantity = 1,
    walletDeducted = 50,
    chargedAmount = 50,
    product = null,
}) => {
    const orderProduct = product || await createProduct({
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
    });

    return Order.create({
        userId: customer._id,
        productId: orderProduct._id,
        orderNumber: uniqueOrderNumber(),
        quantity,
        unitPrice: String(chargedAmount),
        totalPrice: String(chargedAmount),
        basePriceSnapshot: String(chargedAmount),
        markupPercentageSnapshot: 0,
        finalPriceCharged: String(chargedAmount),
        groupIdSnapshot: group._id,
        walletDeducted,
        creditUsedAmount: 0,
        chargedAmount,
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode,
        providerOrderId,
        idempotencyKey: `phase1-${Math.random().toString(36).slice(2)}`,
    });
};

const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
};

describe('Phase 1 blocker remediation: R1 quantity-only entitlement safety', () => {
    it('increments quota for an automatic quantity-only order without a wallet debit', async () => {
        const group = await createGroup({ billingMode: 'quantity_only' });
        const customer = await createCustomer({
            groupId: group._id,
            quantityUsed: 0,
            quantityLimit: 10,
            walletBalance: 100,
        });
        const product = await createProduct({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        const pendingProvider = {
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 'pending-order',
                providerStatus: 'Pending',
                rawResponse: {},
            }),
        };

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 3,
            provider: pendingProvider,
        });

        const updatedCustomer = await freshUser(customer._id);
        await waitFor(
            async () => pendingProvider.placeOrder.mock.calls.length === 1,
            'automatic fulfillment did not start'
        );
        expect(updatedCustomer.quantityUsed).toBe(3);
        expect(order.walletDeducted).toBe(0);
        expect(Number(order.chargedAmount)).toBe(0);
        expect(pendingProvider.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('fails closed for an unsupported provider and restores quota exactly once', async () => {
        const group = await createGroup({ billingMode: 'quantity_only' });
        const customer = await createCustomer({
            groupId: group._id,
            quantityUsed: 4,
            quantityLimit: 10,
            walletBalance: 100,
        });
        const provider = await Provider.create({
            name: 'Unsupported Provider',
            slug: 'unsupported-provider',
            baseUrl: 'https://provider.invalid',
            apiToken: 'test-token',
        });
        const product = await createProduct({
            executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
            provider: provider._id,
        });
        const order = await createProcessingOrder({
            customer,
            group,
            providerCode: provider.slug,
            quantity: 4,
            walletDeducted: 0,
            chargedAmount: 0,
            product,
        });

        const result = await executeOrder(order._id);
        const failedOrder = await Order.findById(order._id);
        const afterFirstFailure = await freshUser(customer._id);
        const repeatedRefund = await refundFailedOrder(failedOrder);
        const afterRepeatedFailure = await freshUser(customer._id);

        expect(result.placed).toBe(false);
        expect(result.refunded).toBe(true);
        expect(failedOrder.status).toBe(ORDER_STATUS.FAILED);
        expect(failedOrder.refunded).toBe(true);
        expect(afterFirstFailure.quantityUsed).toBe(0);
        expect(repeatedRefund).toBe(false);
        expect(afterRepeatedFailure.quantityUsed).toBe(0);
    });

    it('keeps wallet-funded refund behavior idempotent', async () => {
        const group = await createGroup({ billingMode: 'standard' });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 100 });
        const order = await createProcessingOrder({
            customer,
            group,
            providerCode: 'missing-provider',
            walletDeducted: 50,
            chargedAmount: 50,
        });

        expect(await refundFailedOrder(order)).toBe(true);
        expect(await refundFailedOrder(await Order.findById(order._id))).toBe(false);

        const updatedCustomer = await freshUser(customer._id);
        expect(updatedCustomer.walletBalance).toBe(150);
    });
});

describe('Phase 1 blocker remediation: R2 permanent provider-resolution failures', () => {
    it('moves a missing-provider order to MANUAL_REVIEW once without refunding it', async () => {
        const group = await createGroup({ billingMode: 'standard' });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 100 });
        const order = await createProcessingOrder({ customer, group, providerCode: 'removed-provider' });

        const first = await pollProcessingOrders();
        const movedOrder = await Order.findById(order._id);
        const second = await pollProcessingOrders();
        const afterSecondPoll = await Order.findById(order._id);

        expect(first.manualReview).toBe(1);
        expect(movedOrder.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(movedOrder.refunded).toBe(false);
        expect(second.manualReview).toBe(0);
        expect(afterSecondPoll.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect((await freshUser(customer._id)).walletBalance).toBe(100);
    });

    it('moves unsupported-adapter and renamed historical-provider orders to MANUAL_REVIEW', async () => {
        const group = await createGroup({ billingMode: 'standard' });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 100 });
        const unsupportedProvider = await Provider.create({
            name: 'Unsupported Poll Provider',
            slug: 'unsupported-poll-provider',
            baseUrl: 'https://provider.invalid',
            apiToken: 'test-token',
        });
        await Provider.create({
            name: 'Renamed Provider',
            slug: 'renamed-provider',
            baseUrl: 'https://provider.invalid',
            apiToken: 'test-token',
        });
        const unsupportedOrder = await createProcessingOrder({
            customer,
            group,
            providerCode: unsupportedProvider.slug,
            providerOrderId: 'unsupported-order',
        });
        const renamedOrder = await createProcessingOrder({
            customer,
            group,
            providerCode: 'historical-provider-name',
            providerOrderId: 'renamed-order',
        });

        const stats = await pollProcessingOrders();

        expect(stats.manualReview).toBe(2);
        expect((await Order.findById(unsupportedOrder._id)).status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect((await Order.findById(renamedOrder._id)).status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect((await freshUser(customer._id)).walletBalance).toBe(100);
    });

    it('leaves a transient provider polling failure retryable and does not place another order', async () => {
        const group = await createGroup({ billingMode: 'standard' });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 100 });
        const order = await createProcessingOrder({ customer, group, providerCode: 'transient-provider' });
        const providerOverride = {
            checkOrdersBatch: jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
            placeOrder: jest.fn(),
        };

        const stats = await pollProcessingOrders(providerOverride);
        const afterPoll = await Order.findById(order._id);

        expect(stats.manualReview).toBe(0);
        expect(afterPoll.status).toBe(ORDER_STATUS.PROCESSING);
        expect(afterPoll.refunded).toBe(false);
        expect(providerOverride.placeOrder).not.toHaveBeenCalled();
    });
});
