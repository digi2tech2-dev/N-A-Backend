'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_STRATEGIES } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, HAGO_FINANCIAL_MUTATION_STATES } = require('../modules/orders/order.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('../modules/providers/hago/hagoProviderConnection.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const { debitExactWalletAtomic } = require('../modules/wallet/exactLedger.service');
const { unitsToDecimalString } = require('../shared/utils/exactLedgerMoney');
const adminOrders = require('../modules/admin/admin.orders.service');
const { HagoNobilityExecutionService } = require('../modules/providers/hago/hagoNobilityExecution.service');
const {
    connectTestDB, disconnectTestDB, clearCollections, createGroup, createCustomer, createAdmin,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    process.env.EXACT_LEDGER_ENABLED = 'true';
});
afterAll(() => { delete process.env.EXACT_LEDGER_ENABLED; });

const createFixture = async ({ providerCode = 'hago', mutationState = HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, status = ORDER_STATUS.MANUAL_REVIEW, providerTransactionId = null, refunded = false, exactDebit = '0.0001', nobility = true } = {}) => {
    const group = await createGroup({ percentage: 0 });
    const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
    const admin = await createAdmin();
    const provider = await Provider.create({ name: `Hago recovery ${Date.now()}-${Math.random()}`, slug: 'hago', baseUrl: 'https://hago.invalid', syncInterval: 0, isActive: true });
    const providerProduct = await ProviderProduct.create({ provider: provider._id, externalProductId: 'HAGO_NOBILITY_1', rawName: 'Knight', rawPrice: '0', minQty: 1, maxQty: 1 });
    const product = await Product.create({ name: `Knight recovery ${Date.now()}-${Math.random()}`, basePrice: '1', minQty: 1, maxQty: 1, provider: provider._id, providerProduct: providerProduct._id, pricingStrategy: PRICING_STRATEGIES.HAGO_NOBILITY_READINESS, executionType: 'automatic', hagoNobilityPricing: { purchaseBasePrice: '1', renewalBasePrice: '1' } });
    const connection = await HagoProviderConnection.create({ provider: provider._id, connectionId: `con_recovery_${Math.random().toString(36).slice(2)}`, isPrimary: true, enabled: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
    const debit = await debitExactWalletAtomic({ userId: user._id, decimal: exactDebit, sourceKey: `seed-recovery:${user._id}` });
    const order = await Order.create({
        userId: user._id, productId: product._id, orderNumber: `HR${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        quantity: 1, unitPrice: exactDebit, totalPrice: exactDebit, basePriceSnapshot: exactDebit, markupPercentageSnapshot: 0,
        finalPriceCharged: exactDebit, groupIdSnapshot: group._id, profitUsd: '0', currency: 'USD', rateSnapshot: 1, usdAmount: exactDebit,
        chargedAmount: null, walletDeducted: null, creditUsedAmount: null, walletDeductedUnits: debit.walletDeductedUnits,
        status, executionType: 'automatic', providerCode, refunded,
        hagoNobility: nobility ? {
            serviceType: 'NOBILITY', selectedType: 1, requestedTargetId: '365200654', operation: 'RENEW',
            connectionRef: connection._id, providerMutationKey: `hago:nobility:${Math.random().toString(36).slice(2)}`,
            mutationState, providerTransactionId,
        } : undefined,
    });
    return { user, admin, provider, connection, order, exactDebit };
};

describe('Hago Nobility confirmed-pre-send refund recovery', () => {
    test('refunds the persisted exact debit once, terminates the order, and leaves no executable Nobility state', async () => {
        const { order, admin, user, exactDebit } = await createFixture();
        const client = { lookupIntentProof: jest.fn().mockResolvedValue({ status: 'SUCCESS', exists: false, hasProviderTransactionRef: false }) };

        const recovered = await adminOrders.refundHagoNobilityConfirmedPreSend(order._id, admin._id, null, { hagoClient: client });
        expect(client.lookupIntentProof).toHaveBeenCalledTimes(1);
        expect(recovered.status).toBe(ORDER_STATUS.FAILED);
        expect(recovered.refunded).toBe(true);
        expect(recovered.hagoNobility.mutationState).toBe(HAGO_FINANCIAL_MUTATION_STATES.FAILED);
        expect(recovered.hagoNobility.providerStatus).toBe('NOT_SENT');
        const refund = await WalletTransaction.findOne({ userId: user._id, type: TRANSACTION_TYPES.REFUND }).select('+amountUnits');
        expect(unitsToDecimalString(refund.amountUnits)).toBe(exactDebit);

        await expect(adminOrders.refundHagoNobilityConfirmedPreSend(order._id, admin._id, null, { hagoClient: client }))
            .rejects.toMatchObject({ code: 'HAGO_NOBILITY_PRE_SEND_RECOVERY_INVALID_STATE' });
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.REFUND })).toBe(1);

        const send = jest.fn();
        const execution = new HagoNobilityExecutionService({ adapterFactory: () => ({ executeControlledNobility: send }) });
        const executionResult = await execution.execute(order._id);
        expect(executionResult.placed).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    test.each([
        ['persisted HAGO intent', {}, { status: 'SUCCESS', exists: true, hasProviderTransactionRef: false }, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_INTENT_EXISTS'],
        ['HAGO-BOT provider reference', {}, { status: 'SUCCESS', exists: false, hasProviderTransactionRef: true }, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_INTENT_EXISTS'],
        ['order provider reference', { providerTransactionId: 'txn_existing' }, null, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_EVIDENCE_INVALID'],
        ['non-UNKNOWN mutation', { mutationState: HAGO_FINANCIAL_MUTATION_STATES.PENDING }, null, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_INVALID_STATE'],
        ['wrong provider', { providerCode: 'other' }, null, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_NOT_APPLICABLE'],
        ['non-Nobility order', { nobility: false }, null, 'HAGO_NOBILITY_PRE_SEND_RECOVERY_NOT_APPLICABLE'],
    ])('fails closed for %s without a refund', async (_name, fixtureOptions, proof, code) => {
        const { order, admin, user } = await createFixture(fixtureOptions);
        const client = { lookupIntentProof: jest.fn().mockResolvedValue(proof) };
        await expect(adminOrders.refundHagoNobilityConfirmedPreSend(order._id, admin._id, null, { hagoClient: client }))
            .rejects.toMatchObject({ code });
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.REFUND })).toBe(0);
    });

    test('fails closed when the HAGO-BOT proof lookup is unavailable', async () => {
        const { order, admin, user } = await createFixture();
        const client = { lookupIntentProof: jest.fn().mockRejectedValue(new Error('timeout')) };
        await expect(adminOrders.refundHagoNobilityConfirmedPreSend(order._id, admin._id, null, { hagoClient: client }))
            .rejects.toMatchObject({ code: 'HAGO_NOBILITY_PRE_SEND_RECOVERY_PROOF_UNAVAILABLE' });
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.REFUND })).toBe(0);
        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.MANUAL_REVIEW);
    });

    test('rejects an already-refunded matching order without another wallet credit', async () => {
        const { order, admin, user } = await createFixture({ refunded: true });
        const client = { lookupIntentProof: jest.fn() };
        await expect(adminOrders.refundHagoNobilityConfirmedPreSend(order._id, admin._id, null, { hagoClient: client }))
            .rejects.toMatchObject({ code: 'ALREADY_REFUNDED' });
        expect(client.lookupIntentProof).not.toHaveBeenCalled();
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.REFUND })).toBe(0);
    });
});
