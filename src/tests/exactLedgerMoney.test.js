'use strict';

const {
    LEDGER_SCALE,
    MAX_LEDGER_UNITS_DIGITS,
    ExactLedgerMoneyError,
    normalizeDecimalString,
    normalizeUnitsString,
    requireExactStringInput,
    assertCanonicalUnits,
    decimalStringToUnits,
    unitsToDecimalString,
    addUnits,
    subtractUnits,
    compareUnits,
    isPositiveUnits,
    isZeroUnits,
    legacyMoneyToUnits,
    legacyPlatformRateToExact,
    normalizePlatformRateExact,
} = require('../shared/utils/exactLedgerMoney');
const {
    readLegacyAuthoritativeLedger,
    readExactCompatibleLedger,
    serializeExactCompatibleLedger,
} = require('../shared/utils/exactLedgerCompatibility');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Order } = require('../modules/orders/order.model');
const { Currency } = require('../modules/currency/currency.model');
const {
    parseArgs,
    buildUserUpdate,
    buildWalletTransactionUpdate,
    buildOrderUpdate,
    buildCurrencyUpdate,
} = require('../../scripts/backfill-exact-ledger');

describe('phase-1 exact ledger money primitives', () => {
    const examples = [
        '0',
        '1',
        '0.1',
        '0.01',
        '0.001',
        '0.0001',
        '0.0000000000001',
        `0.${'1234567890'.repeat(4)}1234567891`,
    ];

    test.each(examples)('round-trips %s at scale 56', (value) => {
        const units = decimalStringToUnits(value);
        expect(unitsToDecimalString(units)).toBe(value);
    });

    test('normalizes leading and trailing zeros without float conversion', () => {
        expect(normalizeDecimalString('00010.2500')).toBe('10.25');
        expect(normalizeDecimalString('-000.0100')).toBe('-0.01');
        expect(normalizeDecimalString('-0.000')).toBe('0');
        expect(normalizeUnitsString('-000120')).toBe('-120');
    });

    test('performs exact signed unit arithmetic and comparisons', () => {
        const oneMilli = decimalStringToUnits('0.001');
        const oneTenthMilli = decimalStringToUnits('0.0001');
        expect(unitsToDecimalString(addUnits(oneMilli, oneTenthMilli))).toBe('0.0011');
        expect(unitsToDecimalString(subtractUnits(oneMilli, oneTenthMilli))).toBe('0.0009');
        expect(compareUnits(oneTenthMilli, oneMilli)).toBe(-1);
        expect(compareUnits(oneMilli, oneMilli)).toBe(0);
        expect(compareUnits(oneMilli, oneTenthMilli)).toBe(1);
        expect(isPositiveUnits(oneMilli)).toBe(true);
        expect(isZeroUnits(decimalStringToUnits('0'))).toBe(true);
        expect(unitsToDecimalString(subtractUnits(decimalStringToUnits('0'), oneMilli))).toBe('-0.001');
    });

    test('rejects malformed, scientific, excessive-scale, and excessive-whole inputs', () => {
        for (const value of ['', ' ', '1e-7', '+1', '.1', 'Infinity', 'NaN', '1.2.3']) {
            expect(() => decimalStringToUnits(value)).toThrow(ExactLedgerMoneyError);
        }
        expect(() => decimalStringToUnits(`0.${'1'.repeat(LEDGER_SCALE + 1)}`)).toThrow('fractional precision');
        expect(() => decimalStringToUnits(`${'9'.repeat(130)}.1`)).toThrow('whole-digit limit');
        expect(() => normalizeUnitsString('9'.repeat(MAX_LEDGER_UNITS_DIGITS + 1))).toThrow('unit length');
    });

    test('enforces submitted fractional scale before trimming canonical trailing zeroes', () => {
        const scale56 = `0.${'1'.repeat(LEDGER_SCALE)}`;
        expect(unitsToDecimalString(decimalStringToUnits(scale56))).toBe(scale56);
        expect(() => decimalStringToUnits(`0.${'1'.repeat(LEDGER_SCALE + 1)}`)).toThrow('fractional precision');
        expect(() => decimalStringToUnits(`1.${'0'.repeat(LEDGER_SCALE + 1)}`)).toThrow('fractional precision');
        expect(() => decimalStringToUnits(`0.${'0'.repeat(LEDGER_SCALE + 1)}`)).toThrow('fractional precision');
    });

    test('enforces field-specific unit sign and zero rules', () => {
        expect(assertCanonicalUnits('-1', { allowNegative: true, label: 'walletBalanceUnits' })).toBe('-1');
        expect(assertCanonicalUnits('0', { allowNegative: false, label: 'creditLimitUnits' })).toBe('0');
        expect(() => assertCanonicalUnits('-1', { allowNegative: false, label: 'creditLimitUnits' })).toThrow('cannot be negative');
        expect(() => assertCanonicalUnits('0', { allowNegative: false, allowZero: false, label: 'amountUnits' })).toThrow('must be positive');
    });

    test('preserves current legacy two-decimal business semantics without IEEE dust', () => {
        expect(unitsToDecimalString(legacyMoneyToUnits(10.25))).toBe('10.25');
        expect(unitsToDecimalString(legacyMoneyToUnits(0.01))).toBe('0.01');
        expect(unitsToDecimalString(legacyMoneyToUnits(0))).toBe('0');
        expect(unitsToDecimalString(legacyMoneyToUnits(10.249999999999998))).toBe('10.25');
        expect(legacyPlatformRateToExact(50.1234561)).toBe('50.123456');
        expect(normalizePlatformRateExact('50.123456')).toBe('50.123456');
        expect(() => normalizePlatformRateExact('0')).toThrow('positive');
    });

    test('keeps legacy authority separate from exact-compatible reads', () => {
        const legacy = { walletBalance: 10.25, creditLimit: 0.01, creditUsed: 0 };
        expect(readLegacyAuthoritativeLedger(legacy)).toEqual({ authority: 'legacy', ...legacy });

        const compatible = readExactCompatibleLedger(legacy);
        expect(compatible.authority).toBe('legacy-compatible');
        expect(unitsToDecimalString(compatible.units.walletBalanceUnits)).toBe('10.25');

        const exact = {
            ...legacy,
            walletBalanceUnits: decimalStringToUnits('10.25'),
            creditLimitUnits: decimalStringToUnits('0.01'),
            creditUsedUnits: decimalStringToUnits('0'),
            walletLedgerVersion: 3,
        };
        expect(readExactCompatibleLedger(exact).authority).toBe('exact-compatible');
        expect(serializeExactCompatibleLedger(exact).exactLedger).toMatchObject({
            authority: 'exact-compatible',
            walletBalance: '10.25',
            creditLimit: '0.01',
            creditUsed: '0',
            walletLedgerVersion: 3,
        });
    });
});

describe('phase-1 exact ledger schema additions', () => {
    test('adds optional exact fields without changing legacy field definitions', () => {
        expect(User.schema.path('walletBalance').instance).toBe('Number');
        expect(User.schema.path('walletBalanceUnits').instance).toBe('String');
        expect(User.schema.path('walletLedgerVersion').instance).toBe('Number');
        expect(WalletTransaction.schema.path('amount').options.min[0]).toBe(0.01);
        expect(WalletTransaction.schema.path('amountUnits').instance).toBe('String');
        expect(Order.schema.path('chargedAmount').instance).toBe('Number');
        expect(Order.schema.path('chargedAmountUnits').instance).toBe('String');
        expect(Order.schema.path('hagoFinancial.providerAmount').instance).toBe('Number');
        expect(Order.schema.path('inchillFinancial.providerAmount').instance).toBe('Number');
        expect(Currency.schema.path('platformRate').instance).toBe('Number');
        expect(Currency.schema.path('platformRateExact').instance).toBe('String');
    });

    test('rejects numeric exact inputs before Mongoose can coerce them to strings', () => {
        const exactPaths = [
            [User, 'walletBalanceUnits'], [User, 'creditLimitUnits'], [User, 'creditUsedUnits'],
            [WalletTransaction, 'amountUnits'], [WalletTransaction, 'balanceBeforeUnits'], [WalletTransaction, 'balanceAfterUnits'],
            [Order, 'chargedAmountUnits'], [Order, 'walletDeductedUnits'], [Order, 'creditUsedAmountUnits'],
            [Currency, 'platformRateExact'],
        ];
        for (const [Model, path] of exactPaths) {
            const schemaPath = Model.schema.path(path);
            expect(schemaPath.applySetters('1')).toBe('1');
            expect(schemaPath.applySetters(null)).toBeNull();
            expect(() => schemaPath.applySetters(1)).toThrow(ExactLedgerMoneyError);
            expect(() => schemaPath.applySetters(0.1)).toThrow(ExactLedgerMoneyError);
        }
        expect(() => requireExactStringInput(1)).toThrow(ExactLedgerMoneyError);
    });

    test('mirrors legacy sign semantics and validates safe ledger versions', () => {
        const validatorFor = (Model, path) => Model.schema.path(path).validators[0].validator;
        expect(validatorFor(User, 'walletBalanceUnits')('-1')).toBe(true);
        expect(validatorFor(User, 'creditLimitUnits')('-1')).toBe(false);
        expect(validatorFor(User, 'creditUsedUnits')('-1')).toBe(false);
        expect(validatorFor(WalletTransaction, 'amountUnits')('0')).toBe(false);
        expect(validatorFor(WalletTransaction, 'amountUnits')('1')).toBe(true);
        expect(validatorFor(Order, 'chargedAmountUnits')('-1')).toBe(false);
        expect(validatorFor(Order, 'walletDeductedUnits')('0')).toBe(true);
        expect(validatorFor(Order, 'creditUsedAmountUnits')('0')).toBe(true);

        const versionValidator = validatorFor(User, 'walletLedgerVersion');
        for (const invalid of [0.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(versionValidator(invalid)).toBe(false);
        for (const valid of [0, 1, Number.MAX_SAFE_INTEGER]) expect(versionValidator(valid)).toBe(true);
        expect(versionValidator(null)).toBe(true);
    });
});

describe('phase-1 backfill planning', () => {
    test('is dry-run by default and requires a collection-specific resume cursor', () => {
        expect(parseArgs([])).toMatchObject({ write: false, batchSize: 250, resumeAfter: null, collection: null });
        expect(() => parseArgs(['--resume-after=507f1f77bcf86cd799439011'])).toThrow('requires --collection');
        expect(parseArgs(['--write', '--collection=users', '--resume-after=507f1f77bcf86cd799439011'])).toMatchObject({
            write: true,
            collection: 'users',
        });
    });

    test('plans exact compatibility fields from legacy cent values without altering provider fields', () => {
        const userUpdate = buildUserUpdate({ walletBalance: 10.25, creditLimit: 0.01, creditUsed: 0, walletLedgerVersion: null });
        expect(unitsToDecimalString(userUpdate.walletBalanceUnits)).toBe('10.25');
        expect(userUpdate.walletLedgerVersion).toBe(0);

        const transactionUpdate = buildWalletTransactionUpdate({ amount: 0.01, balanceBefore: 10.25, balanceAfter: 10.24 });
        expect(unitsToDecimalString(transactionUpdate.amountUnits)).toBe('0.01');

        const orderUpdate = buildOrderUpdate({ chargedAmount: 0.01, walletDeducted: 0.01, creditUsedAmount: '0' });
        expect(unitsToDecimalString(orderUpdate.chargedAmountUnits)).toBe('0.01');
        expect(Object.keys(orderUpdate)).not.toContain('hagoFinancial');
        expect(Object.keys(orderUpdate)).not.toContain('inchillFinancial');

        expect(buildCurrencyUpdate({ platformRate: 50.123456, platformRateExact: null })).toEqual({ platformRateExact: '50.123456' });
    });

    test('only backfills truly missing exact values and fails closed on existing inconsistencies', () => {
        const baseUser = {
            constructor: { modelName: 'User' }, _id: 'user-id',
            walletBalance: 10.25, creditLimit: 0.01, creditUsed: 0, walletLedgerVersion: 0,
            walletBalanceUnits: null, creditLimitUnits: null, creditUsedUnits: null,
        };
        expect(buildUserUpdate(baseUser)).toMatchObject({ walletBalanceUnits: legacyMoneyToUnits(10.25) });
        expect(() => buildUserUpdate({ ...baseUser, walletBalanceUnits: '' })).toThrow('inconsistent');
        expect(() => buildUserUpdate({ ...baseUser, walletBalanceUnits: 'not-units' })).toThrow('inconsistent');
        expect(() => buildUserUpdate({ ...baseUser, walletBalanceUnits: '1' })).toThrow('inconsistent');
        expect(buildUserUpdate({
            ...baseUser,
            walletBalanceUnits: legacyMoneyToUnits(10.25),
            creditLimitUnits: legacyMoneyToUnits(0.01),
            creditUsedUnits: legacyMoneyToUnits(0),
        })).toEqual({});

        expect(() => buildCurrencyUpdate({ _id: 'currency-id', platformRate: 1, platformRateExact: '' })).toThrow('invalid');
        expect(() => buildCurrencyUpdate({ _id: 'currency-id', platformRate: 1, platformRateExact: 'invalid' })).toThrow('invalid');
        expect(() => buildCurrencyUpdate({ _id: 'currency-id', platformRate: 1, platformRateExact: '2' })).toThrow('inconsistent');
        expect(buildCurrencyUpdate({ _id: 'currency-id', platformRate: 1, platformRateExact: '1' })).toEqual({});
    });
});
