'use strict';

// Phase 3 exact customer-ledger engine. It is intentionally not imported by
// provider adapters. Callers must opt in through EXACT_LEDGER_ENABLED.
const mongoose = require('mongoose');
const { User, USER_STATUS } = require('../users/user.model');
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
} = require('../../shared/utils/exactLedgerMoney');

const MAX_CAS_RETRIES = 4;
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
// Treat a legacy absent/null version as zero only for the initial exact write.
// $expr keeps that compatibility rule in the same conditional mutation as the
// balance update without using an unsafe read-then-write fallback.
const versionFilter = (id, version) => ({
    _id: id,
    $expr: { $eq: [{ $ifNull: ['$walletLedgerVersion', 0] }, version] },
});

const runExactMutation = async ({ userId, type, amountUnits = null, targetBalanceUnits = null, targetCreditLimitUnits = null, reference = null, sourceType = null, sourceId = null, sourceKey = null, description = '', requireActive = false, enforceAvailableFunds = true, session: callerSession = null, requireFeatureGate = true }) => {
    if (requireFeatureGate && !isExactLedgerEnabled()) throw new BusinessRuleError('Exact ledger is not enabled.', 'EXACT_LEDGER_DISABLED');
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
                    .select('+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletLedgerVersion walletBalance creditLimit creditUsed status')
                    .session(session);
                if (!user) throw new NotFoundError('User');
                if (requireActive && user.status !== USER_STATUS.ACTIVE) throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
                const state = deriveState(user);
                const before = state.walletBalanceUnits;
                const creditLimitUnits = requestedCreditLimit ?? state.creditLimitUnits;
                const after = requestedBalance ?? (amount == null ? before : (type === TRANSACTION_TYPES.DEBIT ? subtractUnits(before, amount) : addUnits(before, amount)));
                const transactionType = requestedBalance == null
                    ? type
                    : (compareUnits(after, before) >= 0 ? TRANSACTION_TYPES.CREDIT : TRANSACTION_TYPES.DEBIT);
                const transactionAmount = requestedBalance == null
                    ? amount
                    : (compareUnits(after, before) >= 0 ? subtractUnits(after, before) : subtractUnits(before, after));
                if (transactionType === TRANSACTION_TYPES.DEBIT && enforceAvailableFunds && compareUnits(addUnits(before, creditLimitUnits), transactionAmount) < 0) {
                    throw new InsufficientFundsError(transactionAmount, addUnits(before, creditLimitUnits));
                }
                const creditUsed = creditUsedForBalance(after, creditLimitUnits);
                const nextState = { walletBalanceUnits: after, creditLimitUnits, creditUsedUnits: creditUsed };
                const updated = await User.updateOne(
                    versionFilter(user._id, state.walletLedgerVersion),
                    // Legacy users carry walletLedgerVersion:null. Set the
                    // next CAS value explicitly instead of $inc so the first
                    // exact write can atomically initialize that optional
                    // field as well as update the exact balances.
                    { $set: { ...nextState, ...compatibilityFieldsForState(nextState), walletLedgerVersion: state.walletLedgerVersion + 1 } },
                    { session, runValidators: true }
                );
                if (updated.modifiedCount !== 1) {
                    const conflict = new Error('EXACT_LEDGER_CAS_CONFLICT');
                    conflict.code = 'EXACT_LEDGER_CAS_CONFLICT';
                    throw conflict;
                }
                let transaction = null;
                if (compareUnits(transactionAmount, '0') > 0) {
                    [transaction] = await WalletTransaction.create([{
                        userId: user._id, type: transactionType, amount: null, balanceBefore: null, balanceAfter: null,
                        amountUnits: transactionAmount, balanceBeforeUnits: before, balanceAfterUnits: after,
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

const debitExactWalletAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.DEBIT, amountUnits: unitsFromInput(params), requireActive: params.requireActive !== false, enforceAvailableFunds: params.enforceAvailableFunds !== false });
const creditExactWalletAtomic = (params) => runExactMutation({ ...params, type: params.type || TRANSACTION_TYPES.CREDIT, amountUnits: unitsFromInput(params) });
// A refund for an already exact-debited order must remain possible even if the
// rollout gate is later disabled; it is not a new financial capability.
const refundExactWalletAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.REFUND, amountUnits: unitsFromInput(params), requireFeatureGate: false });
const setExactWalletBalanceAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.CREDIT, targetBalanceUnits: params.targetBalanceUnits, requireActive: false, enforceAvailableFunds: false });
const updateExactCreditLimitAtomic = (params) => runExactMutation({ ...params, type: TRANSACTION_TYPES.CREDIT, targetCreditLimitUnits: params.targetCreditLimitUnits, requireActive: false, enforceAvailableFunds: false });

module.exports = { isExactLedgerEnabled, debitExactWalletAtomic, creditExactWalletAtomic, refundExactWalletAtomic, setExactWalletBalanceAtomic, updateExactCreditLimitAtomic, deriveState, creditUsedForBalance };
