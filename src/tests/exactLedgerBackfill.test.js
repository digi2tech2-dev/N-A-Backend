'use strict';

const { User } = require('../modules/users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { Currency } = require('../modules/currency/currency.model');
const {
    decimalStringToUnits,
    unitsToDecimalString,
    addUnits,
    subtractUnits,
    compareUnits,
    legacyMoneyToUnits,
} = require('../shared/utils/exactLedgerMoney');
const { readExactCompatibleLedger } = require('../shared/utils/exactLedgerCompatibility');
const { toFiat } = require('../shared/utils/decimalPrecision');
const {
    getBackfillCollections,
    runCollection,
} = require('../../scripts/backfill-exact-ledger');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const selected = (document, fields) => document.select(fields).lean();
const exactUserFields = '+walletBalanceUnits +creditLimitUnits +creditUsedUnits +walletLedgerVersion';
const exactTransactionFields = '+amountUnits +balanceBeforeUnits +balanceAfterUnits';
const exactOrderFields = '+chargedAmountUnits +walletDeductedUnits +creditUsedAmountUnits';
const exactCurrencyFields = '+platformRateExact';

const runAllCollections = async ({ write, batchSize = 2 } = {}) => {
    const collections = getBackfillCollections();
    const results = {};
    for (const [name, config] of Object.entries(collections)) {
        results[name] = await runCollection({ ...config, write, batchSize, resumeAfter: null });
    }
    return results;
};

const makeOrder = ({ user, product, group, index, status, chargedAmount, walletDeducted, creditUsedAmount }) => Order.create({
    userId: user._id,
    productId: product._id,
    orderNumber: `XL${index}${Date.now().toString().slice(-7)}`,
    quantity: 1,
    unitPrice: String(chargedAmount),
    totalPrice: String(chargedAmount),
    basePriceSnapshot: String(chargedAmount),
    markupPercentageSnapshot: 0,
    finalPriceCharged: String(chargedAmount),
    groupIdSnapshot: group._id,
    profitUsd: '0',
    walletDeducted,
    creditUsedAmount: String(creditUsedAmount),
    currency: 'USD',
    rateSnapshot: 1,
    usdAmount: String(chargedAmount),
    chargedAmount,
    status,
    executionType: 'manual',
});

const createLegacyFixture = async () => {
    const group = await createGroup({ percentage: 0 });
    const userValues = [0, 0.01, 1, 10.25, -0.5];
    const users = await Promise.all(userValues.map((walletBalance, index) => createCustomer({
        name: `Exact Ledger ${index}`,
        groupId: group._id,
        walletBalance,
        creditLimit: index === 4 ? 1 : 0,
        creditUsed: index === 4 ? 0.5 : 0,
    })));
    const product = await createProduct({ basePrice: '1', executionType: 'manual' });

    const transactions = await WalletTransaction.create([
        { userId: users[1]._id, type: TRANSACTION_TYPES.DEBIT, amount: 0.01, balanceBefore: 0.01, balanceAfter: 0, description: 'legacy debit' },
        { userId: users[3]._id, type: TRANSACTION_TYPES.CREDIT, amount: 1, balanceBefore: 9.25, balanceAfter: 10.25, description: 'legacy credit' },
        { userId: users[3]._id, type: TRANSACTION_TYPES.REFUND, amount: 0.5, balanceBefore: 9.75, balanceAfter: 10.25, description: 'legacy refund' },
    ]);
    const orders = [
        await makeOrder({ user: users[3], product, group, index: 1, status: ORDER_STATUS.COMPLETED, chargedAmount: 1, walletDeducted: 1, creditUsedAmount: 0 }),
        await makeOrder({ user: users[1], product, group, index: 2, status: ORDER_STATUS.FAILED, chargedAmount: 0.01, walletDeducted: 0.01, creditUsedAmount: 0 }),
    ];
    const currencies = await Currency.create([
        { code: 'USD', name: 'US Dollar', symbol: '$', platformRate: 1 },
        { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', platformRate: 50.123456 },
    ]);
    return { group, users, transactions, orders, currencies };
};

const prototypeExactDebit = async ({ userId, expectedVersion, debitUnits }) => {
    const user = await User.findById(userId).select(exactUserFields);
    if (!user || compareUnits(user.walletBalanceUnits, debitUnits) < 0) return null;
    const nextUnits = subtractUnits(user.walletBalanceUnits, debitUnits);
    return User.findOneAndUpdate(
        { _id: userId, walletLedgerVersion: expectedVersion, walletBalanceUnits: user.walletBalanceUnits },
        { $set: { walletBalanceUnits: nextUnits }, $inc: { walletLedgerVersion: 1 } },
        { new: true, runValidators: true }
    ).select(exactUserFields);
};

describe('Phase 2 local exact-ledger backfill', () => {
    test('dry-runs then writes legacy users, transactions, orders, and currencies exactly and idempotently', async () => {
        const fixture = await createLegacyFixture();
        const before = await selected(User.findById(fixture.users[3]._id), exactUserFields);
        expect(before.walletBalance).toBe(10.25);
        expect(before.walletBalanceUnits).toBeNull();
        const beforeOrder = await selected(Order.findById(fixture.orders[1]._id), exactOrderFields);
        expect(Object.keys(getBackfillCollections().orders.buildUpdate(beforeOrder))).toEqual([
            'chargedAmountUnits', 'walletDeductedUnits', 'creditUsedAmountUnits',
        ]);

        const dryRun = await runAllCollections({ write: false, batchSize: 2 });
        expect(dryRun).toEqual({
            users: { scanned: 5, wouldUpdate: 5, updated: 0, skipped: 0 },
            'wallet-transactions': { scanned: 3, wouldUpdate: 3, updated: 0, skipped: 0 },
            orders: { scanned: 2, wouldUpdate: 2, updated: 0, skipped: 0 },
            currencies: { scanned: 2, wouldUpdate: 2, updated: 0, skipped: 0 },
        });
        expect((await selected(User.findById(fixture.users[3]._id), exactUserFields)).walletBalanceUnits).toBeNull();

        const writeRun = await runAllCollections({ write: true, batchSize: 2 });
        expect(writeRun.users.updated).toBe(5);
        expect(writeRun['wallet-transactions'].updated).toBe(3);
        expect(writeRun.orders.updated).toBe(2);
        expect(writeRun.currencies.updated).toBe(2);

        const user = await selected(User.findById(fixture.users[3]._id), exactUserFields);
        expect(user.walletBalance).toBe(10.25);
        expect(user.creditLimit).toBe(0);
        expect(user.walletLedgerVersion).toBe(0);
        expect(user.walletBalanceUnits).toBe(decimalStringToUnits('10.25'));
        expect(unitsToDecimalString(user.walletBalanceUnits)).toBe('10.25');
        expect(readExactCompatibleLedger(user).authority).toBe('exact-compatible');

        const negativeUser = await selected(User.findById(fixture.users[4]._id), exactUserFields);
        expect(unitsToDecimalString(negativeUser.walletBalanceUnits)).toBe('-0.5');
        expect(unitsToDecimalString(negativeUser.creditLimitUnits)).toBe('1');
        expect(unitsToDecimalString(negativeUser.creditUsedUnits)).toBe('0.5');

        const transaction = await selected(WalletTransaction.findById(fixture.transactions[0]._id), exactTransactionFields);
        expect(transaction.amount).toBe(0.01);
        expect(unitsToDecimalString(transaction.amountUnits)).toBe('0.01');
        expect(unitsToDecimalString(transaction.balanceBeforeUnits)).toBe('0.01');
        expect(unitsToDecimalString(transaction.balanceAfterUnits)).toBe('0');

        const order = await selected(Order.findById(fixture.orders[1]._id), exactOrderFields);
        expect(order.chargedAmount).toBe(0.01);
        expect(unitsToDecimalString(order.chargedAmountUnits)).toBe('0.01');
        expect(unitsToDecimalString(order.walletDeductedUnits)).toBe('0.01');

        const egp = await selected(Currency.findById(fixture.currencies[1]._id), exactCurrencyFields);
        expect(egp.platformRate).toBe(50.123456);
        expect(egp.platformRateExact).toBe('50.123456');

        const secondWrite = await runAllCollections({ write: true, batchSize: 2 });
        for (const result of Object.values(secondWrite)) {
            expect(result.wouldUpdate).toBe(0);
            expect(result.updated).toBe(0);
            expect(result.skipped).toBe(result.scanned);
        }
    });

    test('fails closed on persisted inconsistencies and resumes safely from a collection cursor', async () => {
        const fixture = await createLegacyFixture();
        const usersConfig = getBackfillCollections().users;
        const invalidValues = ['', ' ', 'bad-units', '1'];
        for (const invalid of invalidValues) {
            await User.collection.updateOne({ _id: fixture.users[0]._id }, { $set: { walletBalanceUnits: invalid } });
            await expect(runCollection({ ...usersConfig, write: true, batchSize: 10, resumeAfter: null })).rejects.toThrow(/invalid|inconsistent/);
            const raw = await User.collection.findOne({ _id: fixture.users[0]._id });
            expect(raw.walletBalanceUnits).toBe(invalid);
            await User.collection.updateOne({ _id: fixture.users[0]._id }, { $unset: { walletBalanceUnits: '' } });
        }

        const currenciesConfig = getBackfillCollections().currencies;
        for (const invalid of ['', ' ', 'bad-rate', '2']) {
            await Currency.collection.updateOne({ _id: fixture.currencies[0]._id }, { $set: { platformRateExact: invalid } });
            await expect(runCollection({ ...currenciesConfig, write: true, batchSize: 10, resumeAfter: null })).rejects.toThrow(/invalid|inconsistent/);
            const raw = await Currency.collection.findOne({ _id: fixture.currencies[0]._id });
            expect(raw.platformRateExact).toBe(invalid);
            await Currency.collection.updateOne({ _id: fixture.currencies[0]._id }, { $unset: { platformRateExact: '' } });
        }

        const orderedUsers = await User.find({}).sort({ _id: 1 }).select(usersConfig.select);
        const first = orderedUsers[0];
        const firstUpdate = usersConfig.buildUpdate(first);
        await User.collection.updateOne({ _id: first._id }, { $set: firstUpdate });
        const resumed = await runCollection({ ...usersConfig, write: true, batchSize: 1, resumeAfter: first._id.toString() });
        expect(resumed.scanned).toBe(orderedUsers.length - 1);
        expect(resumed.updated).toBe(orderedUsers.length - 1);

        const firstAfterResume = await selected(User.findById(first._id), exactUserFields);
        expect(firstAfterResume.walletBalanceUnits).toBe(firstUpdate.walletBalanceUnits);
    });

    test('keeps mixed legacy/exact reads compatible and shadows cent and micro arithmetic exactly', async () => {
        const group = await createGroup({ percentage: 0 });
        const legacyUser = await createCustomer({ groupId: group._id, walletBalance: 10.25, creditLimit: 0.01, creditUsed: 0 });
        const exactUser = await createCustomer({
            groupId: group._id,
            walletBalance: 10.25,
            creditLimit: 0.01,
            creditUsed: 0,
            walletBalanceUnits: decimalStringToUnits('10.25'),
            creditLimitUnits: decimalStringToUnits('0.01'),
            creditUsedUnits: decimalStringToUnits('0'),
            walletLedgerVersion: 0,
        });
        const legacy = await selected(User.findById(legacyUser._id), exactUserFields);
        const exact = await selected(User.findById(exactUser._id), exactUserFields);
        expect(readExactCompatibleLedger(legacy).authority).toBe('legacy-compatible');
        expect(unitsToDecimalString(readExactCompatibleLedger(legacy).units.walletBalanceUnits)).toBe('10.25');
        expect(readExactCompatibleLedger(exact).authority).toBe('exact-compatible');

        for (const amount of ['10.25', '1.00', '0.50', '0.10', '0.01']) {
            const legacyFiat = toFiat(amount);
            const exactShadow = unitsToDecimalString(legacyMoneyToUnits(legacyFiat));
            expect(exactShadow).toBe(unitsToDecimalString(decimalStringToUnits(String(legacyFiat))));
        }

        const micro = decimalStringToUnits('0.0000000000001');
        const one = decimalStringToUnits('1');
        const postDebit = subtractUnits(one, micro);
        expect(unitsToDecimalString(postDebit)).toBe('0.9999999999999');
        expect(unitsToDecimalString(addUnits(postDebit, micro))).toBe('1');
        for (const value of ['0.001', '0.0001', '0.000001', '0.0000000000001']) {
            expect(unitsToDecimalString(decimalStringToUnits(value))).toBe(value);
        }
    });

    test('prototype exact CAS prevents stale writers and insufficient-balance lost updates locally', async () => {
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            walletBalance: 1,
            walletBalanceUnits: decimalStringToUnits('1'),
            creditLimitUnits: decimalStringToUnits('0'),
            creditUsedUnits: decimalStringToUnits('0'),
            walletLedgerVersion: 0,
        });
        const debit = decimalStringToUnits('0.1');
        const [first, stale] = await Promise.all([
            prototypeExactDebit({ userId: user._id, expectedVersion: 0, debitUnits: debit }),
            prototypeExactDebit({ userId: user._id, expectedVersion: 0, debitUnits: debit }),
        ]);
        expect([first, stale].filter(Boolean)).toHaveLength(1);
        const afterFirst = await selected(User.findById(user._id), exactUserFields);
        expect(afterFirst.walletLedgerVersion).toBe(1);
        expect(unitsToDecimalString(afterFirst.walletBalanceUnits)).toBe('0.9');

        const retry = await prototypeExactDebit({ userId: user._id, expectedVersion: 1, debitUnits: debit });
        expect(retry).not.toBeNull();
        const afterRetry = await selected(User.findById(user._id), exactUserFields);
        expect(afterRetry.walletLedgerVersion).toBe(2);
        expect(unitsToDecimalString(afterRetry.walletBalanceUnits)).toBe('0.8');
        expect(await prototypeExactDebit({ userId: user._id, expectedVersion: 2, debitUnits: decimalStringToUnits('1') })).toBeNull();
        expect(unitsToDecimalString(addUnits(afterRetry.walletBalanceUnits, debit))).toBe('0.9');

        const limitedUser = await createCustomer({
            groupId: group._id,
            walletBalance: 0.1,
            walletBalanceUnits: decimalStringToUnits('0.1'),
            creditLimitUnits: decimalStringToUnits('0'),
            creditUsedUnits: decimalStringToUnits('0'),
            walletLedgerVersion: 0,
        });
        const [limitedWinner, limitedStale] = await Promise.all([
            prototypeExactDebit({ userId: limitedUser._id, expectedVersion: 0, debitUnits: debit }),
            prototypeExactDebit({ userId: limitedUser._id, expectedVersion: 0, debitUnits: debit }),
        ]);
        expect([limitedWinner, limitedStale].filter(Boolean)).toHaveLength(1);
        expect(await prototypeExactDebit({ userId: limitedUser._id, expectedVersion: 1, debitUnits: debit })).toBeNull();
        const exhausted = await selected(User.findById(limitedUser._id), exactUserFields);
        expect(unitsToDecimalString(exhausted.walletBalanceUnits)).toBe('0');
        expect(exhausted.walletLedgerVersion).toBe(1);
    });
});
