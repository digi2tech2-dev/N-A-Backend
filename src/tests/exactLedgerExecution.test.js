'use strict';

const { User } = require('../modules/users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const {
    debitExactWalletAtomic,
    creditExactWalletAtomic,
    refundExactWalletAtomic,
    isExactLedgerEnabled,
    deriveState,
} = require('../modules/wallet/exactLedger.service');
const { decimalStringToUnits, unitsToDecimalString } = require('../shared/utils/exactLedgerMoney');
const { convertUsdDecimalToUserCurrencyExact } = require('../services/currencyConverter.service');
const { Currency } = require('../modules/currency/currency.model');
const { Order } = require('../modules/orders/order.model');
const { createOrder, markOrderAsFailed, processOrderRefund } = require('../modules/orders/order.service');
const { completeOrder } = require('../modules/admin/admin.orders.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const { debitWalletAtomic, creditWalletDirect } = require('../modules/wallet/wallet.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    createProduct,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
const originalExactLedgerEnabled = process.env.EXACT_LEDGER_ENABLED;
beforeEach(async () => {
    await clearCollections();
    delete process.env.EXACT_LEDGER_ENABLED;
});
afterAll(() => {
    if (originalExactLedgerEnabled === undefined) delete process.env.EXACT_LEDGER_ENABLED;
    else process.env.EXACT_LEDGER_ENABLED = originalExactLedgerEnabled;
});

const exactFields = '+walletBalanceUnits +creditLimitUnits +creditUsedUnits +walletLedgerVersion';
const txExactFields = '+amountUnits +balanceBeforeUnits +balanceAfterUnits';

describe('Phase 3 exact customer-ledger execution gate', () => {
    test('feature off rejects an exact debit before any financial write', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        await expect(debitExactWalletAtomic({ userId: user._id, decimal: '0.001' }))
            .rejects.toMatchObject({ code: 'EXACT_LEDGER_DISABLED' });
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
        const fresh = await User.findById(user._id).select(exactFields);
        expect(fresh.walletBalance).toBe(1);
        expect(fresh.walletBalanceUnits).toBeNull();
    });

    test('feature off retains the legacy checkout and wallet write behavior', async () => {
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const product = await createProduct({ basePrice: '0.01', minQty: 1, maxQty: 10, executionType: 'manual' });
        const { order } = await createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `legacy-order:${user._id}` });
        const persisted = await Order.findById(order._id).select('+chargedAmountUnits +walletDeductedUnits');
        expect(persisted.chargedAmount).toBe(0.01);
        expect(persisted.walletDeducted).toBe(0.01);
        expect(persisted.chargedAmountUnits).toBeNull();
        await creditWalletDirect({ userId: user._id, amount: 1, description: 'legacy credit' });
        await debitWalletAtomic({ userId: user._id, amount: 1, description: 'legacy debit' });
        const fresh = await User.findById(user._id).select(exactFields);
        expect(fresh.walletBalance).toBe(0.99);
        expect(fresh.walletBalanceUnits).toBeNull();
    });

    test('feature on debits and refunds a micro amount exactly without changing the legacy balance', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        expect(isExactLedgerEnabled()).toBe(true);
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id, walletBalance: 1, creditLimit: 0, creditUsed: 0 });
        const micro = '0.0000000000001';

        const debit = await debitExactWalletAtomic({
            userId: user._id,
            decimal: micro,
            sourceKey: `exact-test-debit:${user._id}`,
            description: 'micro debit',
        });
        expect(unitsToDecimalString(debit.balanceBeforeUnits)).toBe('1');
        expect(unitsToDecimalString(debit.balanceAfterUnits)).toBe('0.9999999999999');

        let fresh = await User.findById(user._id).select(exactFields);
        expect(fresh.walletBalance).toBe(1); // legacy authority is unchanged by exact writes
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('0.9999999999999');
        expect(fresh.walletLedgerVersion).toBe(1);
        const selectedForEngine = await User.findById(user._id)
            .select('+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletLedgerVersion walletBalance creditLimit creditUsed status');
        expect(deriveState(selectedForEngine).walletLedgerVersion).toBe(1);

        await refundExactWalletAtomic({
            userId: user._id,
            units: decimalStringToUnits(micro),
            sourceKey: `exact-test-refund:${user._id}`,
            description: 'micro refund',
        });
        fresh = await User.findById(user._id).select(exactFields);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('1');
        expect(fresh.walletLedgerVersion).toBe(2);

        const transactions = await WalletTransaction.find({ userId: user._id }).select(txExactFields).sort({ createdAt: 1 });
        expect(transactions).toHaveLength(2);
        expect(transactions[0].type).toBe(TRANSACTION_TYPES.DEBIT);
        expect(transactions[0].amount).toBeNull();
        expect(unitsToDecimalString(transactions[0].amountUnits)).toBe(micro);
        expect(transactions[1].type).toBe(TRANSACTION_TYPES.REFUND);
        expect(unitsToDecimalString(transactions[1].amountUnits)).toBe(micro);
    });

    test('exact conversion preserves a sub-cent USD total and the six-decimal currency rate', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', platformRate: 50.123456 });
        const result = await convertUsdDecimalToUserCurrencyExact('0.000146116138799', 'EGP');
        expect(result.rateExact).toBe('50.123456');
        expect(result.finalAmount).not.toBe('0');
        expect(unitsToDecimalString(decimalStringToUnits(result.finalAmount))).toBe(result.finalAmount);
    });

    test('concurrent micro debits serialize through the exact ledger version without a lost update', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const debit = () => debitExactWalletAtomic({ userId: user._id, decimal: '0.001', sourceKey: `exact-concurrent:${user._id}:${Math.random()}` });
        await Promise.all([debit(), debit()]);
        const fresh = await User.findById(user._id).select(exactFields);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('0.998');
        expect(fresh.walletLedgerVersion).toBe(2);
    });

    test('credit accepts a micro amount and preserves exact transaction snapshots', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const result = await creditExactWalletAtomic({ userId: user._id, decimal: '0.000001', sourceKey: `exact-credit:${user._id}` });
        expect(unitsToDecimalString(result.balanceAfterUnits)).toBe('0.000001');
        const tx = await WalletTransaction.findById(result.transaction._id).select(txExactFields);
        expect(unitsToDecimalString(tx.balanceBeforeUnits)).toBe('0');
        expect(unitsToDecimalString(tx.balanceAfterUnits)).toBe('0.000001');
    });

    test('admin adjustments and shared deposit/referral credits follow initialized exact authority', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const admin = await createAdmin();
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        await debitExactWalletAtomic({ userId: user._id, decimal: '0.0001', sourceKey: `seed-micro:${user._id}` });
        await adminWalletService.addFunds(user._id, 1, 'admin credit', admin._id);
        await adminWalletService.deductFunds(user._id, 0.5, 'admin debit', admin._id);
        await creditWalletDirect({ userId: user._id, amount: 0.25, sourceType: 'DEPOSIT', sourceKey: `deposit:${user._id}` });
        await creditWalletDirect({ userId: user._id, amount: 0.25, sourceType: 'REFERRAL_PAYOUT', sourceKey: `referral:${user._id}` });
        const fresh = await User.findById(user._id).select(exactFields);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('1.9999');
        // The exact balance has micro precision, so the compatibility Number is
        // intentionally not overwritten; all mutations above used exact state.
        expect(fresh.walletBalance).toBe(1);
    });

    test('gated checkout snapshots and refunds a micro customer charge without entering a provider path', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const product = await createProduct({ basePrice: '0.0001', minQty: 1, maxQty: 10, executionType: 'manual' });

        const { order } = await createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `exact-order:${user._id}` });
        const persisted = await Order.findById(order._id)
            .select('+chargedAmountUnits +walletDeductedUnits +creditUsedAmountUnits');
        expect(persisted.chargedAmount).toBeNull();
        expect(persisted.walletDeducted).toBeNull();
        expect(persisted.totalPrice).toBe('0.0001');
        expect(unitsToDecimalString(persisted.chargedAmountUnits)).toBe('0.0001');
        expect(unitsToDecimalString(persisted.walletDeductedUnits)).toBe('0.0001');

        await markOrderAsFailed(persisted._id);
        const fresh = await User.findById(user._id).select(exactFields);
        expect(fresh.walletBalance).toBe(1);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('1');
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.REFUND })).toBe(1);
    });

    test('partial exact refund uses deterministic integer-unit allocation', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const product = await createProduct({ basePrice: '0.0000000000001', minQty: 1, maxQty: 10, executionType: 'manual' });
        const { order } = await createOrder({ userId: user._id, productId: product._id, quantity: 3, idempotencyKey: `exact-partial:${user._id}` });

        await processOrderRefund(order._id, 1);
        const fresh = await User.findById(user._id).select(exactFields);
        // 1 - (3 × 10^-13) + (1 × 10^-13)
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('0.9999999999998');
        const refund = await WalletTransaction.findOne({ userId: user._id, type: TRANSACTION_TYPES.REFUND }).select(txExactFields);
        expect(unitsToDecimalString(refund.amountUnits)).toBe('0.0000000000001');
    });

    test('force-completing a refunded exact order re-debits its persisted exact snapshot', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const admin = await createAdmin();
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const product = await createProduct({ basePrice: '0.0001', minQty: 1, maxQty: 10, executionType: 'manual' });
        const { order } = await createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `force-complete:${user._id}` });
        await markOrderAsFailed(order._id);
        await completeOrder(order._id, admin._id);
        const fresh = await User.findById(user._id).select(exactFields);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('0.9999');
        const redeductions = await WalletTransaction.find({ userId: user._id, type: TRANSACTION_TYPES.DEBIT }).select(txExactFields);
        expect(redeductions).toHaveLength(2);
        expect(unitsToDecimalString(redeductions[1].amountUnits)).toBe('0.0001');
    });

    test('concurrent first-use exact checkouts retry before fulfillment and do not lose a debit', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const product = await createProduct({ basePrice: '0.001', minQty: 1, maxQty: 10, executionType: 'manual' });
        await Promise.all([
            createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `race-a:${user._id}` }),
            createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `race-b:${user._id}` }),
        ]);
        const fresh = await User.findById(user._id).select(exactFields);
        expect(unitsToDecimalString(fresh.walletBalanceUnits)).toBe('0.998');
        expect(fresh.walletLedgerVersion).toBe(2);
    });
});
