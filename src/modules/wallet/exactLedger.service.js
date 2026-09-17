'use strict';

// Phase 3 exact customer-ledger engine. It is intentionally not imported by
// provider adapters. Callers must opt in through EXACT_LEDGER_ENABLED.
const mongoose = require('mongoose');
const { User, USER_STATUS } = require('../users/user.model');
const { Currency } = require('../currency/currency.model');
const Decimal = require('decimal.js');
const { WalletTransaction, TRANSACTION_TYPES } = require('./walletTransaction.model');
const { BusinessRuleError, InsufficientFundsError, NotFoundError } = require('../../shared/errors/AppError');
const {
    decimalStringToUnits,
    normalizeUnitsString,
    addUnits,
    subtractUnits,
    compareUnits,
    legacyMoneyToUnits,
    unitsToDecimalString,
    normalizeDecimalString,
    normalizePlatformRateExact,
    legacyPlatformRateToExact,
    LEDGER_SCALE,
} = require('../../shared/utils/exactLedgerMoney');

const MAX_CAS_RETRIES = 4;
const ExactDecimal = Decimal.clone({ precision: 250, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -1000, toExpPos: 1000 });
const isExactLedgerEnabled = () => ['true', '1', 'on', 'yes'].includes(String(process.env.EXACT_LEDGER_ENABLED || '').trim().toLowerCase());
const unitsFromInput = ({ units, decimal, label = 'Amount' }) => {
    if (units != null) return normalizeUnitsString(units, { label });
    return decimalStringToUnits(decimal, { label, allowNegative: false });
};
const deriveState = (user) => ({
    walletBalanceUnits: user.walletBalanceUnits ?? legacyMoneyToUnits(user.walletBalance ?? 0, { label: 'walletBalance' }),
    creditLimitUnits: user.creditLimitUnits ?? legacyMoneyToUnits(user.creditLimit ?? 0, { label: 'creditLimit' }),
    creditUsedUnits: user.creditUsedUnits ?? legacyMoneyToUnits(user.creditUsed ?? 0, { label: 'creditUsed' }),
    walletLedgerVersion: Number.isSafeInteger(user.walletLedgerVersion) && user.walletLedgerVersion >= 0 ? user.walletLedgerVersion : 0,
});
const creditUsedForBalance = (balance, limit) => {
    if (compareUnits(balance, '0') >= 0 || compareUnits(limit, '0') <= 0) return '0';
    const debt = subtractUnits('0', balance);
    return compareUnits(debt, limit) > 0 ? limit : debt;
};
const legacyCompatibleNumber = (units) => {
    const decimal = unitsToDecimalString(units);
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
    const numeric = Number(decimal);
    return Number.isFinite(numeric) ? numeric : null;
};
const compatibilityFieldsForState = ({ walletBalanceUnits, creditLimitUnits, creditUsedUnits }) => {
    const walletBalance = legacyCompatibleNumber(walletBalanceUnits);
    const creditLimit = legacyCompatibleNumber(creditLimitUnits);
    const creditUsed = legacyCompatibleNumber(creditUsedUnits);
    return {
        ...(walletBalance == null ? {} : { walletBalance }),
        ...(creditLimit == null ? {} : { creditLimit }),
        ...(creditUsed == null ? {} : { creditUsed }),
    };
};
// A denomination conversion must not leave the legacy Number mirrors in the
// previous currency. Preserve exact authority while publishing a safe 2dp
// compatibility value in the new denomination.
const convertedCompatibilityNumber = (units) => {
    const rounded = new ExactDecimal(unitsToDecimalString(units))
        .toDecimalPlaces(2, ExactDecimal.ROUND_HALF_UP)
        .toFixed(2);
    const numeric = Number(rounded);
    if (!Number.isFinite(numeric)) return null;
    const roundTripped = new ExactDecimal(numeric.toString())
        .toDecimalPlaces(2, ExactDecimal.ROUND_HALF_UP)
        .toFixed(2);
    if (roundTripped !== rounded) return null;
    return numeric;
};
const compatibilityFieldsForConvertedState = (state) => {
    const walletBalance = convertedCompatibilityNumber(state.walletBalanceUnits);
    const creditLimit = convertedCompatibilityNumber(state.creditLimitUnits);
    const creditUsed = convertedCompatibilityNumber(state.creditUsedUnits);
    if (walletBalance == null || creditLimit == null || creditUsed == null) {
        throw new BusinessRuleError('Converted wallet state cannot be represented safely by legacy compatibility fields.', 'EXACT_LEDGER_COMPATIBILITY_UNREPRESENTABLE');
    }
    return { walletBalance, creditLimit, creditUsed };
};
// Treat a legacy absent/null version as zero only for the initial exact write.
// $expr keeps that compatibility rule in the same conditional mutation as the
// balance update without using an unsafe read-then-write fallback.
const versionFilter = (id, version) => ({
    _id: id,
    $expr: { $eq: [{ $ifNull: ['$walletLedgerVersion', 0] }, version] },
});

const normalizeCurrencyCode = (value, label = 'Currency') => {
    const code = String(value || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new BusinessRuleError(`${label} must be a valid ISO currency code.`, 'INVALID_CURRENCY');
    return code;
};

const resolveExactCurrencyRate = async (currencyCode, { session, requireActive, source = false } = {}) => {
    const code = normalizeCurrencyCode(currencyCode, source ? 'Source currency' : 'Target currency');
    if (code === 'USD') return { code, rateExact: '1' };

    const currency = await Currency.findOne({ code })
        .select('code isActive platformRate +platformRateExact')
        .session(session);
    const unavailableCode = source ? 'EXACT_LEDGER_SOURCE_CURRENCY_RATE_UNAVAILABLE' : 'INVALID_CURRENCY';
    if (!currency || (requireActive && !currency.isActive)) {
        throw new BusinessRuleError(
            source ? `Source currency '${code}' cannot be resolved safely.` : `Currency '${code}' is not active or does not exist.`,
            unavailableCode
        );
    }

    try {
        const rateExact = typeof currency.platformRateExact === 'string' && currency.platformRateExact.trim()
            ? normalizePlatformRateExact(currency.platformRateExact)
            : legacyPlatformRateToExact(currency.platformRate);
        return { code, rateExact };
    } catch (_) {
        throw new BusinessRuleError(
            source ? `Source currency '${code}' has an invalid platform rate.` : `Currency '${code}' has an invalid platform rate.`,
            unavailableCode
        );
    }
};

const convertExactCurrencyUnits = ({ amountUnits, sourceRateExact, targetRateExact, label = 'Exact currency amount' }) => {
    const sourceUnits = normalizeUnitsString(amountUnits, { label });
    const sourceRate = normalizePlatformRateExact(sourceRateExact);
    const targetRate = normalizePlatformRateExact(targetRateExact);
    const sourceDecimal = unitsToDecimalString(sourceUnits);
    const result = new ExactDecimal(sourceDecimal).div(sourceRate).times(targetRate);
    if (!result.isFinite()) throw new BusinessRuleError('Exact currency conversion overflowed.', 'EXACT_LEDGER_CURRENCY_CONVERSION_INVALID');

    const targetDecimal = normalizeDecimalString(
        result.toDecimalPlaces(LEDGER_SCALE, ExactDecimal.ROUND_HALF_UP).toFixed(LEDGER_SCALE),
        { allowNegative: true, maxFractionDigits: LEDGER_SCALE, label }
    );
    const targetUnits = decimalStringToUnits(targetDecimal, { allowNegative: true, label });
    return { sourceUnits, sourceDecimal, targetUnits, targetDecimal, sourceRateExact: sourceRate, targetRateExact: targetRate };
};

const runExactMutation = async ({ userId, expectedCurrency, type, amountUnits = null, targetBalanceUnits = null, targetCreditLimitUnits = null, reference = null, sourceType = null, sourceId = null, sourceKey = null, description = '', requireActive = false, enforceAvailableFunds = true, session: callerSession = null, requireFeatureGate = true }) => {
    if (requireFeatureGate && !isExactLedgerEnabled()) throw new BusinessRuleError('Exact ledger is not enabled.', 'EXACT_LEDGER_DISABLED');
    // Amount units have no intrinsic denomination. Every exact mutation must
    // carry the currency in which its amount/target was calculated; reading a
    // current wallet currency here would allow stale units to cross currencies.
    const mutationCurrency = normalizeCurrencyCode(expectedCurrency, 'Expected currency');
    const amount = amountUnits == null ? null : normalizeUnitsString(amountUnits, { label: 'Exact amount' });
    if (amount != null && compareUnits(amount, '0') <= 0) throw new BusinessRuleError('Amount must be greater than zero.', 'INVALID_AMOUNT');
    const requestedBalance = targetBalanceUnits == null ? null : normalizeUnitsString(targetBalanceUnits, { label: 'Target wallet balance' });
    const requestedCreditLimit = targetCreditLimitUnits == null ? null : normalizeUnitsString(targetCreditLimitUnits, { label: 'Target credit limit' });
    if (requestedCreditLimit != null && compareUnits(requestedCreditLimit, '0') < 0) throw new BusinessRuleError('Credit limit cannot be negative.', 'INVALID_CREDIT_LIMIT');
    if (amount == null && requestedBalance == null && requestedCreditLimit == null) throw new BusinessRuleError('An exact ledger mutation is required.', 'INVALID_AMOUNT');

    // Exact writes never use the legacy standalone fallback.  A caller that
    // already owns an order/refund transaction passes its session so the user,
    // immutable transaction and order snapshot commit together.  Direct
    // callers receive an internal Mongo transaction with bounded CAS retries.
    if (callerSession && !callerSession.inTransaction()) {
        throw new BusinessRuleError('Exact ledger mutations require an active MongoDB transaction.', 'EXACT_LEDGER_TRANSACTION_REQUIRED');
    }
    const attempts = callerSession ? 1 : MAX_CAS_RETRIES;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const session = callerSession || await mongoose.startSession();
        try {
            let result;
            const execute = async () => {
                const user = await User.findById(userId)
                    // walletLedgerVersion is a normal visible field. Use an
                    // inclusion projection (not `+`) here: mixed projections
                    // otherwise omit it and falsely reset CAS to zero.
                    .select('+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletLedgerVersion walletBalance creditLimit creditUsed status currency')
                    .session(session);
                if (!user) throw new NotFoundError('User');
                if (requireActive && user.status !== USER_STATUS.ACTIVE) throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
                const currentCurrency = normalizeCurrencyCode(user.currency || 'USD');
                if (mutationCurrency !== currentCurrency) {
                    throw new BusinessRuleError('Wallet currency changed while this exact ledger mutation was pending. Retry using the new denomination.', 'EXACT_LEDGER_CURRENCY_CHANGED');
                }
                const state = deriveState(user);
                const before = state.walletBalanceUnits;
                const creditLimitUnits = requestedCreditLimit ?? state.creditLimitUnits;
                const after = requestedBalance ?? (amount == null ? before : (type === TRANSACTION_TYPES.DEBIT ? subtractUnits(before, amount) : addUnits(before, amount)));
                const transactionType = requestedBalance == null
                    ? type
                    : (compareUnits(after, before) >= 0 ? TRANSACTION_TYPES.CREDIT : TRANSACTION_TYPES.DEBIT);
                // A target credit-limit mutation changes no wallet balance and
                // must not create a synthetic CREDIT/DEBIT transaction.
                const transactionAmount = requestedBalance == null
                    ? (amount ?? '0')
                    : (compareUnits(after, before) >= 0 ? subtractUnits(after, before) : subtractUnits(before, after));
                if (transactionType === TRANSACTION_TYPES.DEBIT && enforceAvailableFunds && compareUnits(addUnits(before, creditLimitUnits), transactionAmount) < 0) {
                    throw new InsufficientFundsError(transactionAmount, addUnits(before, creditLimitUnits));
                }
                const creditUsed = creditUsedForBalance(after, creditLimitUnits);
                const nextState = { walletBalanceUnits: after, creditLimitUnits, creditUsedUnits: creditUsed };
                const updated = await User.updateOne(
                    { ...versionFilter(user._id, state.walletLedgerVersion), currency: mutationCurrency },
                    // Legacy users carry walletLedgerVersion:null. Set the
                    // next CAS value explicitly instead of $inc so the first
                    // exact write can atomically initialize that optional
                    // field as well as update the exact balances.
                    { $set: { ...nextState, ...compatibilityFieldsForState(nextState), walletLedgerVersion: state.walletLedgerVersion + 1 } },
                    { session, runValidators: true }
                );
                if (updated.modifiedCount !== 1) {
                    const conflict = new Error('EXACT_LEDGER_CAS_CONFLICT');
                    // A failed version CAS alone is not proof of a currency
                    // conversion: same-currency wallet activity is retried by
                    // the normal exact-ledger conflict path. On the next
                    // standalone attempt the explicit expectedCurrency check
                    // classifies a real denomination change before arithmetic.
                    conflict.code = 'EXACT_LEDGER_CAS_CONFLICT';
                    throw conflict;
                }
                let transaction = null;
                if (compareUnits(transactionAmount, '0') > 0) {
                    [transaction] = await WalletTransaction.create([{
                        userId: user._id, type: transactionType, amount: null, balanceBefore: null, balanceAfter: null,
                        amountUnits: transactionAmount, balanceBeforeUnits: before, balanceAfterUnits: after,
                        currency: mutationCurrency,
                        reference, sourceType, sourceId, sourceKey: sourceKey || null, status: 'COMPLETED', description,
                    }], { session });
                }
                result = { transaction, walletDeductedUnits: transactionType === TRANSACTION_TYPES.DEBIT ? transactionAmount : '0', creditUsedAmountUnits: transactionType === TRANSACTION_TYPES.DEBIT ? subtractUnits(creditUsed, state.creditUsedUnits) : '0', balanceBeforeUnits: before, balanceAfterUnits: after, creditLimitUnits, creditUsedUnits: creditUsed };
            };
            if (callerSession) await execute();
            else await session.withTransaction(execute, {
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
            });
            return result;
        } catch (error) {
            if (error.code !== 'EXACT_LEDGER_CAS_CONFLICT' || attempt === attempts - 1) throw error;
        } finally {
            if (!callerSession) await session.endSession();
        }
    }
    throw new Error('Exact ledger CAS retries exhausted.');
};

/**
 * Converts the denomination of a user's authoritative exact wallet state.
 * This is deliberately separate from a CREDIT/DEBIT mutation: no financial
 * value is created, and all denomination-bearing fields change together.
 */
const convertExactWalletCurrencyAtomic = async ({ userId, targetCurrency }) => {
    if (!isExactLedgerEnabled()) throw new BusinessRuleError('Exact ledger is not enabled.', 'EXACT_LEDGER_DISABLED');
    const targetCode = normalizeCurrencyCode(targetCurrency, 'Target currency');
    let initialSourceCurrency = null;

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
        const session = await mongoose.startSession();
        try {
            let result;
            await session.withTransaction(async () => {
                const user = await User.findById(userId)
                    .select('+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletLedgerVersion walletBalance creditLimit creditUsed currency')
                    .session(session);
                if (!user) throw new NotFoundError('User');

                const sourceCode = normalizeCurrencyCode(user.currency || 'USD', 'Source currency');
                // The final desired denomination already exists: a concurrent
                // same-target conversion is idempotent and must not re-scale.
                if (sourceCode === targetCode) {
                    result = { changed: false, userId: user._id, currency: sourceCode, walletLedgerVersion: deriveState(user).walletLedgerVersion };
                    return;
                }
                if (initialSourceCurrency == null) initialSourceCurrency = sourceCode;
                else if (initialSourceCurrency !== sourceCode) {
                    throw new BusinessRuleError('Wallet currency changed while this conversion was pending. Retry with the current denomination.', 'EXACT_LEDGER_CURRENCY_CHANGED');
                }

                const state = deriveState(user);
                // MongoDB transactions do not support parallel operations on
                // one session, so resolve both rate snapshots sequentially.
                const sourceRate = await resolveExactCurrencyRate(sourceCode, { session, requireActive: false, source: true });
                const targetRate = await resolveExactCurrencyRate(targetCode, { session, requireActive: true });
                const balance = convertExactCurrencyUnits({
                    amountUnits: state.walletBalanceUnits,
                    sourceRateExact: sourceRate.rateExact,
                    targetRateExact: targetRate.rateExact,
                    label: 'walletBalanceUnits',
                });
                const creditLimit = convertExactCurrencyUnits({
                    amountUnits: state.creditLimitUnits,
                    sourceRateExact: sourceRate.rateExact,
                    targetRateExact: targetRate.rateExact,
                    label: 'creditLimitUnits',
                });
                const nextState = {
                    walletBalanceUnits: balance.targetUnits,
                    creditLimitUnits: creditLimit.targetUnits,
                    creditUsedUnits: creditUsedForBalance(balance.targetUnits, creditLimit.targetUnits),
                };
                const compatibility = compatibilityFieldsForConvertedState(nextState);
                const nextVersion = state.walletLedgerVersion + 1;
                const updated = await User.updateOne(
                    { ...versionFilter(user._id, state.walletLedgerVersion), currency: sourceCode },
                    {
                        $set: {
                            currency: targetCode,
                            ...nextState,
                            ...compatibility,
                            walletLedgerVersion: nextVersion,
                        },
                    },
                    { session, runValidators: true }
                );
                if (updated.modifiedCount !== 1) {
                    const conflict = new Error('EXACT_LEDGER_CAS_CONFLICT');
                    conflict.code = 'EXACT_LEDGER_CAS_CONFLICT';
                    throw conflict;
                }
                result = {
                    changed: true,
                    userId: user._id,
                    previousCurrency: sourceCode,
                    newCurrency: targetCode,
                    sourceRateExact: sourceRate.rateExact,
                    targetRateExact: targetRate.rateExact,
                    previousBalance: balance.sourceDecimal,
                    newBalance: balance.targetDecimal,
                    previousCreditLimit: creditLimit.sourceDecimal,
                    newCreditLimit: creditLimit.targetDecimal,
                    previousCreditUsed: unitsToDecimalString(state.creditUsedUnits),
                    newCreditUsed: unitsToDecimalString(nextState.creditUsedUnits),
                    previousWalletLedgerVersion: state.walletLedgerVersion,
                    newWalletLedgerVersion: nextVersion,
                };
            }, {
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
            });
            return result;
        } catch (error) {
            if (error.code !== 'EXACT_LEDGER_CAS_CONFLICT' || attempt === MAX_CAS_RETRIES - 1) throw error;
        } finally {
            await session.endSession();
        }
    }
    throw new Error('Exact ledger currency conversion CAS retries exhausted.');
};

const debitExactWalletAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.DEBIT, amountUnits: unitsFromInput(params), requireActive: params.requireActive !== false, enforceAvailableFunds: params.enforceAvailableFunds !== false });
const creditExactWalletAtomic = (params) => runExactMutation({ ...params, type: params.type || TRANSACTION_TYPES.CREDIT, amountUnits: unitsFromInput(params) });
// A refund for an already exact-debited order must remain possible even if the
// rollout gate is later disabled; it is not a new financial capability.
const refundExactWalletAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.REFUND, amountUnits: unitsFromInput(params), requireFeatureGate: false });
const setExactWalletBalanceAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.CREDIT, targetBalanceUnits: params.targetBalanceUnits, requireActive: false, enforceAvailableFunds: false });
const updateExactCreditLimitAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.CREDIT, targetCreditLimitUnits: params.targetCreditLimitUnits, requireActive: false, enforceAvailableFunds: false });

module.exports = {
    isExactLedgerEnabled,
    debitExactWalletAtomic,
    creditExactWalletAtomic,
    refundExactWalletAtomic,
    setExactWalletBalanceAtomic,
    updateExactCreditLimitAtomic,
    convertExactWalletCurrencyAtomic,
    convertExactCurrencyUnits,
    deriveState,
    creditUsedForBalance,
};
