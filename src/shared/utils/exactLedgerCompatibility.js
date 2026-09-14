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

module.exports = {
    readLegacyAuthoritativeLedger,
    readExactCompatibleLedger,
    serializeExactCompatibleLedger,
};
