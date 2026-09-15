'use strict';

const walletService = require('./wallet.service');
const { WalletTransaction } = require('./walletTransaction.model');
const { User } = require('../users/user.model');
const { isExactLedgerEnabled } = require('./exactLedger.service');
const {
    addUnits,
    legacyMoneyToUnits,
    unitsToDecimalString,
} = require('../../shared/utils/exactLedgerMoney');
const { serializeExactCompatibleLedger } = require('../../shared/utils/exactLedgerCompatibility');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

/**
 * Get the authenticated user's transaction history.
 */
const getMyTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

/**
 * Admin: Get any user's transaction history.
 */
const getUserTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.params.userId, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

/**
 * Get the authenticated user's wallet stats (aggregated from WalletTransaction).
 */
const getMyWalletStats = catchAsync(async (req, res) => {
    const userId = req.user._id;

    if (isExactLedgerEnabled()) {
        const [user, transactions] = await Promise.all([
            User.findById(userId).select('+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletBalance creditLimit creditUsed'),
            WalletTransaction.find({ userId, status: 'COMPLETED' })
                .select('+amountUnits amount type'),
        ]);

        const totals = transactions.reduce((result, transaction) => {
            const amountUnits = typeof transaction.amountUnits === 'string' && transaction.amountUnits.trim()
                ? transaction.amountUnits
                : legacyMoneyToUnits(transaction.amount ?? 0, { label: 'transaction amount' });
            if (transaction.type === 'CREDIT') result.totalDeposits = addUnits(result.totalDeposits, amountUnits);
            if (transaction.type === 'DEBIT') result.totalSpent = addUnits(result.totalSpent, amountUnits);
            if (transaction.type === 'REFUND') result.totalRefunds = addUnits(result.totalRefunds, amountUnits);
            return result;
        }, { totalDeposits: '0', totalSpent: '0', totalRefunds: '0' });
        const { exactLedger } = serializeExactCompatibleLedger(user || {});

        return sendSuccess(res, {
            totalDeposits: unitsToDecimalString(totals.totalDeposits),
            totalSpent: unitsToDecimalString(totals.totalSpent),
            totalRefunds: unitsToDecimalString(totals.totalRefunds),
            netBalance: exactLedger.walletBalance,
            totalTransactions: transactions.length,
        }, 'Wallet stats retrieved.');
    }

    const [agg] = await WalletTransaction.aggregate([
        { $match: { userId, status: 'COMPLETED' } },
        {
            $group: {
                _id: null,
                totalDeposits: {
                    $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] },
                },
                totalSpent: {
                    $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] },
                },
                totalRefunds: {
                    $sum: { $cond: [{ $eq: ['$type', 'REFUND'] }, '$amount', 0] },
                },
                totalTransactions: { $sum: 1 },
            },
        },
    ]);

    const stats = {
        totalDeposits: agg?.totalDeposits || 0,
        totalSpent: agg?.totalSpent || 0,
        totalRefunds: agg?.totalRefunds || 0,
        netBalance: Number(req.user.walletBalance || 0),
        totalTransactions: agg?.totalTransactions || 0,
    };

    sendSuccess(res, stats, 'Wallet stats retrieved.');
});

module.exports = { getMyTransactions, getUserTransactions, getMyWalletStats };
