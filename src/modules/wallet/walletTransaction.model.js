'use strict';

const mongoose = require('mongoose');
const { requireExactStringInput, assertCanonicalUnits } = require('../../shared/utils/exactLedgerMoney');

const isCanonicalLedgerUnits = (options) => (value) => {
    if (value == null) return true;
    try { return assertCanonicalUnits(value, options) === value; } catch (_) { return false; }
};

const exactStringSetter = (label) => (value) => requireExactStringInput(value, { label });

/**
 * Wallet transaction types.
 */
const TRANSACTION_TYPES = Object.freeze({
    CREDIT: 'CREDIT',
    DEBIT: 'DEBIT',
    REFUND: 'REFUND',
    DEBT_ADJUSTMENT: 'DEBT_ADJUSTMENT',
});

/**
 * Transaction status values.
 */
const TRANSACTION_STATUS = Object.freeze({
    PENDING: 'PENDING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const WALLET_TRANSACTION_SOURCE_TYPES = Object.freeze({
    ORDER: 'ORDER',
    DEPOSIT: 'DEPOSIT',
    REFERRAL_PAYOUT: 'REFERRAL_PAYOUT',
    ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
});

const walletTransactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },

        type: {
            type: String,
            enum: Object.values(TRANSACTION_TYPES),
            required: [true, 'Transaction type is required'],
        },

        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: [0.01, 'Amount must be greater than 0'],
        },

        // Phase 1 exact-ledger compatibility snapshots. The existing Number
        // fields above remain authoritative until an explicit ledger cut-over.
        amountUnits: {
            type: String,
            default: null,
            select: false,
            set: exactStringSetter('amountUnits'),
            validate: { validator: isCanonicalLedgerUnits({ allowNegative: false, allowZero: false, label: 'amountUnits' }), message: 'amountUnits must be canonical positive exact ledger units' },
        },

        balanceBefore: {
            type: Number,
            required: [true, 'Balance before is required'],
        },

        balanceBeforeUnits: {
            type: String,
            default: null,
            select: false,
            set: exactStringSetter('balanceBeforeUnits'),
            validate: { validator: isCanonicalLedgerUnits({ allowNegative: true, label: 'balanceBeforeUnits' }), message: 'balanceBeforeUnits must be canonical exact ledger units' },
        },

        balanceAfter: {
            type: Number,
            required: [true, 'Balance after is required'],
        },

        balanceAfterUnits: {
            type: String,
            default: null,
            select: false,
            set: exactStringSetter('balanceAfterUnits'),
            validate: { validator: isCanonicalLedgerUnits({ allowNegative: true, label: 'balanceAfterUnits' }), message: 'balanceAfterUnits must be canonical exact ledger units' },
        },

        reference: {
            // Typically references an Order ID
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
        },

        sourceType: {
            type: String,
            enum: Object.values(WALLET_TRANSACTION_SOURCE_TYPES),
            default: null,
            index: true,
        },

        sourceId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        sourceKey: {
            type: String,
            trim: true,
            default: null,
            maxlength: [160, 'sourceKey cannot exceed 160 characters'],
        },

        status: {
            type: String,
            enum: Object.values(TRANSACTION_STATUS),
            default: TRANSACTION_STATUS.COMPLETED,
        },

        description: {
            type: String,
            trim: true,
            maxlength: 255,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for efficient user transaction history queries
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ reference: 1 });
walletTransactionSchema.index(
    { sourceKey: 1 },
    {
        unique: true,
        partialFilterExpression: { sourceKey: { $type: 'string' } },
        name: 'unique_wallet_transaction_source_key',
    }
);

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

module.exports = {
    WalletTransaction,
    TRANSACTION_TYPES,
    TRANSACTION_STATUS,
    WALLET_TRANSACTION_SOURCE_TYPES,
};
