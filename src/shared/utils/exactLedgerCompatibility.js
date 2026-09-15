'use strict';

/**
 * Phase-1 readers for additive exact-ledger fields.
 *
 * `readLegacyAuthoritativeLedger` is the only reader intended for current
 * checkout/debit/refund code. `readExactCompatibleLedger` exists solely for
 * migration, serializers, and shadow tests until a later explicit cut-over.
 */

const {
    legacyMoneyToUnits,
    normalizeUnitsString,
    unitsToDecimalString,
} = require('./exactLedgerMoney');

const LEDGER_FIELDS = Object.freeze([
    ['walletBalance', 'walletBalanceUnits'],
    ['creditLimit', 'creditLimitUnits'],
    ['creditUsed', 'creditUsedUnits'],
]);

const readLegacyAuthoritativeLedger = (source = {}) => ({
    authority: 'legacy',
    walletBalance: source.walletBalance ?? 0,
    creditLimit: source.creditLimit ?? 0,
    creditUsed: source.creditUsed ?? 0,
});

const readExactCompatibleLedger = (source = {}) => {
    const units = {};
    const sources = {};
    for (const [legacyField, exactField] of LEDGER_FIELDS) {
        if (typeof source[exactField] === 'string' && source[exactField].trim()) {
            units[exactField] = normalizeUnitsString(source[exactField]);
            sources[exactField] = 'exact';
        } else {
            units[exactField] = legacyMoneyToUnits(source[legacyField] ?? 0, { label: legacyField });
            sources[exactField] = 'legacy-compatible';
        }
    }
    return {
        authority: Object.values(sources).every((value) => value === 'exact') ? 'exact-compatible' : 'legacy-compatible',
        units,
        sources,
        walletLedgerVersion: Number.isSafeInteger(source.walletLedgerVersion) && source.walletLedgerVersion >= 0
            ? source.walletLedgerVersion
            : 0,
    };
};

const serializeExactCompatibleLedger = (source = {}) => {
    const compatible = readExactCompatibleLedger(source);
    return {
        exactLedger: {
            authority: compatible.authority,
            walletBalance: unitsToDecimalString(compatible.units.walletBalanceUnits),
            creditLimit: unitsToDecimalString(compatible.units.creditLimitUnits),
            creditUsed: unitsToDecimalString(compatible.units.creditUsedUnits),
            walletLedgerVersion: compatible.walletLedgerVersion,
        },
    };
};

const toPlainObject = (source = {}) => {
    if (source?.toSafeObject) return source.toSafeObject();
    if (source?.toObject) return source.toObject();
    return { ...source };
};

const withoutExactFields = (source, fields) => {
    const serialized = toPlainObject(source);
    for (const field of fields) delete serialized[field];
    return serialized;
};

const decimalForExactField = (source, exactField, legacyField) => {
    if (typeof source?.[exactField] === 'string' && source[exactField].trim()) {
        return unitsToDecimalString(source[exactField]);
    }
    if (source?.[legacyField] == null) return null;
    return unitsToDecimalString(legacyMoneyToUnits(source[legacyField], { label: legacyField }));
};

/**
 * Public exact-ledger serializers deliberately retain the existing monetary
 * property names while removing the internal scale-56 unit strings.
 */
const serializeExactCompatibleUser = (source = {}) => {
    const { exactLedger } = serializeExactCompatibleLedger(source);
    return {
        ...withoutExactFields(source, ['walletBalanceUnits', 'creditLimitUnits', 'creditUsedUnits']),
        walletBalance: exactLedger.walletBalance,
        creditLimit: exactLedger.creditLimit,
        creditUsed: exactLedger.creditUsed,
    };
};

const serializeExactCompatibleTransaction = (source = {}) => ({
    ...withoutExactFields(source, ['amountUnits', 'balanceBeforeUnits', 'balanceAfterUnits']),
    amount: decimalForExactField(source, 'amountUnits', 'amount'),
    balanceBefore: decimalForExactField(source, 'balanceBeforeUnits', 'balanceBefore'),
    balanceAfter: decimalForExactField(source, 'balanceAfterUnits', 'balanceAfter'),
});

const serializeExactCompatibleOrder = (source = {}) => ({
    ...withoutExactFields(source, ['chargedAmountUnits', 'walletDeductedUnits', 'creditUsedAmountUnits']),
    chargedAmount: decimalForExactField(source, 'chargedAmountUnits', 'chargedAmount'),
    walletDeducted: decimalForExactField(source, 'walletDeductedUnits', 'walletDeducted'),
    creditUsedAmount: decimalForExactField(source, 'creditUsedAmountUnits', 'creditUsedAmount'),
});

module.exports = {
    readLegacyAuthoritativeLedger,
    readExactCompatibleLedger,
    serializeExactCompatibleLedger,
    serializeExactCompatibleUser,
    serializeExactCompatibleTransaction,
    serializeExactCompatibleOrder,
};
