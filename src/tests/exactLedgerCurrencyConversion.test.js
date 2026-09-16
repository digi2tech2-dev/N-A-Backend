'use strict';

const { User } = require('../modules/users/user.model');
const { Currency } = require('../modules/currency/currency.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const { AuditLog } = require('../modules/audit/audit.model');
const adminUsersService = require('../modules/admin/admin.users.service');
const {
    debitExactWalletAtomic,
    convertExactWalletCurrencyAtomic,
} = require('../modules/wallet/exactLedger.service');
const { decimalStringToUnits, unitsToDecimalString } = require('../shared/utils/exactLedgerMoney');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
const originalExactLedgerEnabled = process.env.EXACT_LEDGER_ENABLED;
beforeEach(async () => {
    await clearCollections();
    process.env.EXACT_LEDGER_ENABLED = 'true';
});
afterAll(() => {
    if (originalExactLedgerEnabled === undefined) delete process.env.EXACT_LEDGER_ENABLED;
    else process.env.EXACT_LEDGER_ENABLED = originalExactLedgerEnabled;
});

const exactFields = '+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletLedgerVersion currency walletBalance creditLimit creditUsed';
const exact = (decimal) => decimalStringToUnits(decimal, { label: 'test amount', allowNegative: true });
const fresh = (id) => User.findById(id).select(exactFields);

const seedRates = async () => {
    await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', platformRate: 50 });
    await Currency.create({ code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', platformRate: 3.75 });
};
const createExactCustomer = async (overrides = {}) => {
    const group = await createGroup();
    return createCustomer({
        groupId: group._id,
        currency: 'EGP',
        walletBalance: 0,
        creditLimit: 0,
        creditUsed: 0,
        walletBalanceUnits: exact('200'),
        creditLimitUnits: exact('50'),
        creditUsedUnits: exact('0'),
        walletLedgerVersion: 7,
        ...overrides,
    });
};

describe('exact-ledger admin currency conversion', () => {
    test('converts EGP to USD atomically and recomputes credit usage', async () => {
        await seedRates();
        const user = await createExactCustomer({
            walletBalanceUnits: exact('-100'), creditLimitUnits: exact('150'), creditUsedUnits: exact('99'),
        });
        const admin = await createAdmin();

        await adminUsersService.updateUserCurrency(user._id, 'USD', admin._id);
        const updated = await fresh(user._id);
        expect(updated.currency).toBe('USD');
        expect(unitsToDecimalString(updated.walletBalanceUnits)).toBe('-2');
        expect(unitsToDecimalString(updated.creditLimitUnits)).toBe('3');
        expect(unitsToDecimalString(updated.creditUsedUnits)).toBe('2');
        expect(updated.walletBalance).toBe(-2);
        expect(updated.creditLimit).toBe(3);
        expect(updated.creditUsed).toBe(2);
        expect(updated.walletLedgerVersion).toBe(8);
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });

    test('converts USD to EGP and EGP to another non-USD currency', async () => {
        await seedRates();
        const user = await createExactCustomer({
            currency: 'USD', walletBalanceUnits: exact('4'), creditLimitUnits: exact('2'), walletLedgerVersion: 0,
        });
        await convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'EGP' });
        await convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'SAR' });
        const updated = await fresh(user._id);
        expect(updated.currency).toBe('SAR');
        expect(unitsToDecimalString(updated.walletBalanceUnits)).toBe('15');
        expect(unitsToDecimalString(updated.creditLimitUnits)).toBe('7.5');
        expect(updated.walletLedgerVersion).toBe(2);
    });

    test('preserves zero and scale-56 precision as exact authoritative units', async () => {
        await seedRates();
        const zero = await createExactCustomer({ walletBalanceUnits: '0', creditLimitUnits: '0', creditUsedUnits: '0' });
        await convertExactWalletCurrencyAtomic({ userId: zero._id, targetCurrency: 'USD' });
        expect(unitsToDecimalString((await fresh(zero._id)).walletBalanceUnits)).toBe('0');

        const micro = await createExactCustomer({
            walletBalanceUnits: exact('0.00000000000000000000000000000000000000000000000001'),
            creditLimitUnits: '0', creditUsedUnits: '0',
        });
        await convertExactWalletCurrencyAtomic({ userId: micro._id, targetCurrency: 'USD' });
        const converted = await fresh(micro._id);
        expect(unitsToDecimalString(converted.walletBalanceUnits)).not.toBe('0');
        // The exact result is rounded once to the scale-56 boundary; the
        // compatibility Number is derived independently and cannot become old EGP.
        expect(converted.walletBalance).toBe(0);
    });

    test('rejects inactive targets and missing source rates before writing', async () => {
        await seedRates();
        await Currency.updateOne({ code: 'SAR' }, { $set: { isActive: false } });
        const user = await createExactCustomer();
        await expect(convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'SAR' }))
            .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
        expect((await fresh(user._id)).currency).toBe('EGP');

        await Currency.deleteOne({ code: 'EGP' });
        await expect(convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }))
            .rejects.toMatchObject({ code: 'EXACT_LEDGER_SOURCE_CURRENCY_RATE_UNAVAILABLE' });
        expect((await fresh(user._id)).currency).toBe('EGP');
    });

    test('rejects an invalid persisted non-USD source rate with zero writes', async () => {
        await seedRates();
        const user = await createExactCustomer();
        await Currency.collection.updateOne({ code: 'EGP' }, { $set: { platformRateExact: 'invalid' } });
        await expect(convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }))
            .rejects.toMatchObject({ code: 'EXACT_LEDGER_SOURCE_CURRENCY_RATE_UNAVAILABLE' });
        const unchanged = await fresh(user._id);
        expect(unchanged.currency).toBe('EGP');
        expect(unchanged.walletLedgerVersion).toBe(7);
        expect(unitsToDecimalString(unchanged.walletBalanceUnits)).toBe('200');
    });

    test('allows migration out of an inactive but valid source currency', async () => {
        await seedRates();
        await Currency.updateOne({ code: 'EGP' }, { $set: { isActive: false } });
        const user = await createExactCustomer();
        await convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' });
        expect((await fresh(user._id)).currency).toBe('USD');
    });

    test('same-target concurrent requests are idempotent and do not double-convert', async () => {
        await seedRates();
        const user = await createExactCustomer();
        await Promise.all([
            convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }),
            convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }),
        ]);
        const updated = await fresh(user._id);
        expect(updated.currency).toBe('USD');
        expect(unitsToDecimalString(updated.walletBalanceUnits)).toBe('4');
        expect(updated.walletLedgerVersion).toBe(8);
    });

    test('a debit committed before conversion is retained and converted without a fake transaction', async () => {
        await seedRates();
        const user = await createExactCustomer();
        await debitExactWalletAtomic({ userId: user._id, expectedCurrency: 'EGP', decimal: '50', sourceKey: `currency-debit:${user._id}` });
        await convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' });
        const updated = await fresh(user._id);
        expect(unitsToDecimalString(updated.walletBalanceUnits)).toBe('3');
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: TRANSACTION_TYPES.DEBIT })).toBe(1);
    });

    test('a debit that loses a denomination race cannot apply its old units after conversion', async () => {
        await seedRates();
        const user = await createExactCustomer();
        const [debit, conversion] = await Promise.allSettled([
            debitExactWalletAtomic({ userId: user._id, expectedCurrency: 'EGP', decimal: '50', sourceKey: `currency-race:${user._id}` }),
            convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }),
        ]);
        expect(conversion.status).toBe('fulfilled');
        const updated = await fresh(user._id);
        expect(updated.currency).toBe('USD');
        // Either the EGP debit won and was converted (3 USD), or it lost and
        // aborted. It must never subtract the original 50 as USD.
        expect(['3', '4']).toContain(unitsToDecimalString(updated.walletBalanceUnits));
        if (debit.status === 'rejected') expect(debit.reason.code).toBe('EXACT_LEDGER_CURRENCY_CHANGED');
    });

    test('rejects stale EGP units when the wallet was converted before the first mutation read', async () => {
        await seedRates();
        const user = await createExactCustomer();
        await convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' });

        await expect(debitExactWalletAtomic({
            userId: user._id,
            expectedCurrency: 'EGP',
            decimal: '100',
            sourceKey: `stale-egp-debit:${user._id}`,
        })).rejects.toMatchObject({ code: 'EXACT_LEDGER_CURRENCY_CHANGED' });

        const unchanged = await fresh(user._id);
        expect(unchanged.currency).toBe('USD');
        expect(unitsToDecimalString(unchanged.walletBalanceUnits)).toBe('4');
        expect(unchanged.walletLedgerVersion).toBe(8);
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });

    test('conflicting concurrent target currencies fail closed instead of chaining conversions', async () => {
        await seedRates();
        const user = await createExactCustomer();
        const results = await Promise.allSettled([
            convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'USD' }),
            convertExactWalletCurrencyAtomic({ userId: user._id, targetCurrency: 'SAR' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')?.reason.code).toBe('EXACT_LEDGER_CURRENCY_CHANGED');
        const updated = await fresh(user._id);
        expect(['USD', 'SAR']).toContain(updated.currency);
        expect(updated.walletLedgerVersion).toBe(8);
    });

    test('exact admin audit records denomination evidence without a fake wallet transaction', async () => {
        await seedRates();
        const user = await createExactCustomer();
        const admin = await createAdmin();
        await adminUsersService.updateUserCurrency(user._id, 'USD', admin._id);
        await new Promise((resolve) => setImmediate(resolve));
        const audit = await AuditLog.findOne({ entityId: user._id }).sort({ createdAt: -1 });
        expect(audit.metadata).toMatchObject({
            previousCurrency: 'EGP', newCurrency: 'USD', sourceRateExact: '50', targetRateExact: '1',
            previousBalance: '200', newBalance: '4', previousWalletLedgerVersion: 7, newWalletLedgerVersion: 8,
        });
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: { $in: [TRANSACTION_TYPES.CREDIT, TRANSACTION_TYPES.DEBIT] } })).toBe(0);
    });

    test('legacy behavior remains unchanged when the exact-ledger gate is off', async () => {
        await seedRates();
        await Currency.create({ code: 'USD', name: 'US Dollar', symbol: '$', platformRate: 1 });
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 200 });
        const admin = await createAdmin();
        delete process.env.EXACT_LEDGER_ENABLED;
        await adminUsersService.updateUserCurrency(user._id, 'USD', admin._id);
        const updated = await User.findById(user._id).select('+walletBalanceUnits');
        expect(updated.currency).toBe('USD');
        expect(updated.walletBalance).toBe(4);
        expect(updated.walletBalanceUnits).toBeNull();
    });
});
