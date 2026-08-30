'use strict';

const mongoose = require('mongoose');

const ORDER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',     // ← wallet deducted, awaiting provider confirmation
    COMPLETED: 'COMPLETED',
    CANCELED: 'CANCELED',         // ← provider explicitly canceled → full refund
    PARTIAL: 'PARTIAL',           // ← provider delivered partial quantity → partial refund
    FAILED: 'FAILED',
    MANUAL_REVIEW: 'MANUAL_REVIEW', // ← DLQ kill-switch: exceeded MAX_RETRY_COUNT, needs admin
});

const ORDER_EXECUTION_TYPES = Object.freeze({
    MANUAL: 'manual',
    AUTOMATIC: 'automatic',    // ← NEW: goes through provider fulfillment engine
});

// Hago Diamond/Crystal is deliberately separate from the generic provider
// lifecycle. A financial request can be ambiguous after it leaves N&A, so an
// UNKNOWN outcome must never fall through to the generic FAILED/refund path.
const HAGO_FINANCIAL_MUTATION_STATES = Object.freeze({
    READY: 'READY',
    CLAIMED: 'CLAIMED',
    SENT: 'SENT',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    PENDING: 'PENDING',
    UNKNOWN: 'UNKNOWN',
});

/**
 * Maximum number of automatic status-poll retries before the kill switch fires.
 * At a 5-minute cron cadence, 24 retries ≈ 2 hours of polling.
 * Orders exceeding this are moved to MANUAL_REVIEW instead of being auto-failed,
 * preserving the wallet deduction until an admin inspects and resolves the order.
 */
const MAX_RETRY_COUNT = 24;

const orderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },

        /**
         * Short, human-readable random order identifier.
         * Auto-assigned at creation time.
         */
        orderNumber: {
            type: String,
            uppercase: true,
            trim: true,
            unique: true,
            index: true,
        },

        compatOrderId: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
            index: true,
        },

        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product ID is required'],
        },

        quantity: {
            type: Number,
            required: [true, 'Quantity is required'],
            min: [1, 'Quantity must be at least 1'],
        },

        unitPrice: {
            // Legacy field — equals finalPriceCharged. Kept for backwards-compat.
            type: String,
            required: [true, 'Unit price is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        totalPrice: {
            type: String,
            required: [true, 'Total price is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        // ── Pricing Snapshots ────────────────────────────────────────────────
        // Written ONCE at creation. Immutable. Source of truth for accounting.

        /** Raw product basePrice at time of order. */
        basePriceSnapshot: {
            type: String,
            required: [true, 'basePriceSnapshot is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        /** The group's markup percentage applied at time of order. */
        markupPercentageSnapshot: {
            type: Number,
            required: [true, 'markupPercentageSnapshot is required'],
            min: [0, 'markupPercentageSnapshot cannot be negative'],
        },

        /** Final per-unit price charged (basePrice + markup). */
        finalPriceCharged: {
            type: String,
            required: [true, 'finalPriceCharged is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        /** Snapshot of the group the user belonged to at time of order. */
        groupIdSnapshot: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            required: [true, 'groupIdSnapshot is required'],
        },

        /**
         * Net profit in USD for this order.
         * = (finalPriceCharged - basePriceSnapshot) × quantity.
         * Written once at creation time. Immutable.
         */
        profitUsd: {
            type: String,
            default: '0',
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        // ── Financial Split Tracking ─────────────────────────────────────────

        walletDeducted: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Wallet deducted cannot be negative'],
        },

        creditUsedAmount: {
            type: String,
            required: true,
            default: '0',
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        // ── Currency Snapshot ────────────────────────────────────────────────
        // Written ONCE at creation. Immutable. Ensures historical accuracy
        // even when platform exchange rates are updated later.

        /**
         * ISO 4217 currency code of the user's wallet at the time of order.
         * e.g. "USD", "SAR", "EGP"
         * Defaults to "USD" for orders created before multi-currency was added.
         */
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'USD',
        },

        /**
         * The platform exchange rate used to convert USD → user currency
         * at the moment the order was created.
         * Always 1 for USD users. Immutable after creation.
         */
        rateSnapshot: {
            type: Number,
            default: 1,
            min: [0, 'rateSnapshot cannot be negative'],
        },

        /**
         * The product price in USD (before currency conversion).
         * = basePriceSnapshot × (1 + markupPercentageSnapshot/100) × quantity.
         * Used to pay providers (always USD).
         */
        usdAmount: {
            type: String,
            default: null,
            get: (v) => v != null ? String(v) : null,
            set: (v) => v != null ? String(v) : null,
        },

        /**
         * The amount deducted from the user's wallet, in user currency.
         * = usdAmount × rateSnapshot.
         * This is the authoritative charge amount for wallet operations.
         */
        chargedAmount: {
            type: Number,
            default: null,
            min: [0, 'chargedAmount cannot be negative'],
        },

        // ── Order Status ─────────────────────────────────────────────────────

        status: {
            type: String,
            enum: Object.values(ORDER_STATUS),
            default: ORDER_STATUS.PENDING,
        },

        executionType: {
            type: String,
            enum: Object.values(ORDER_EXECUTION_TYPES),
            default: ORDER_EXECUTION_TYPES.MANUAL,
        },

        /**
         * Admin-provided reason when an order is rejected/failed.
         * Visible to customers on the storefront.
         * Null for non-rejected orders.
         */
        rejectionReason: {
            type: String,
            trim: true,
            default: null,
        },

        // ── Idempotency ──────────────────────────────────────────────────────

        idempotencyKey: {
            type: String,
            trim: true,
            default: null,
            sparse: true,
        },

        // ── Timestamps for audit ─────────────────────────────────────────────

        refundedAt: {
            type: Date,
            default: null,
        },

        failedAt: {
            type: Date,
            default: null,
        },

        // ══════════════════════════════════════════════════════════════════════
        // Provider Fulfillment Fields (new — all default null / 0 / false)
        // ══════════════════════════════════════════════════════════════════════

        /**
         * The provider's numeric order ID returned by PlaceOrder.
         * Used by CheckOrder / CheckListOrders polling.
         * Null until provider accepts the order.
         */
        /**
         * Immutable snapshot of the provider's canonical slug/code at the time
         * the order was placed (e.g. 'alkasr', 'royal-crown', 'toros').
         *
         * Written ONCE at createOrder() time from providerDoc.slug (||.name).
         * The cron groups PROCESSING orders by THIS field — NOT by traversing
         * the Product — so admin route/provider changes never corrupt polling.
         */
        providerCode: {
            type: String,
            lowercase: true,
            trim: true,
            default: null,
            index: true,
        },

        providerOrderId: {
            type: mongoose.Schema.Types.Mixed,  // Number (Royal Crown) OR String (Alkasr "ID_xxx")
            default: null,
            index: true,              // cron queries PROCESSING + providerOrderId != null
        },

        /**
         * Last raw status string returned by the provider
         * ('Pending', 'Completed', 'Cancelled').
         * Mapped to ORDER_STATUS separately.
         */
        providerStatus: {
            type: String,
            default: null,
        },

        /** Complete raw JSON body returned by the last provider API call. */
        providerRawResponse: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        /**
         * Reserved, provider-safe execution snapshot for the future controlled
         * Hago Nobility mutation phase. Phase 1 never creates an executable
         * order or stores upstream session material here.
         */
        hagoNobility: {
            selectedType: { type: Number, min: 1, max: 4, default: null },
            selectedName: { type: String, default: null },
            requestedTargetId: { type: String, default: null },
            operation: { type: String, enum: ['PURCHASE', 'RENEW'], default: null },
            readinessAt: { type: Date, default: null },
            readinessConfigFingerprint: { type: String, default: null },
            providerDiamondCost: { type: Number, default: null, min: 0 },
            providerCostCurrency: { type: String, default: null },
            pricingBranch: { type: String, enum: ['purchase', 'renewal'], default: null },
            branchBasePrice: { type: String, default: null },
            connectionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'HagoProviderConnection', default: null },
            mutationState: { type: String, default: null },
            providerMutationKey: { type: String, default: null },
            providerTransactionId: { type: String, default: null },
        },

        /**
         * Internal, service-scoped execution evidence for controlled Hago
         * Diamond/Crystal transfers. It intentionally stores the local
         * connection reference only -- never the opaque upstream connectionId.
         */
        hagoFinancial: {
            serviceType: { type: String, enum: ['DIAMOND', 'CRYSTAL'], default: null },
            requestedTargetId: { type: String, default: null },
            providerAmount: { type: Number, default: null, min: 1 },
            connectionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'HagoProviderConnection', default: null, select: false },
            providerMutationKey: { type: String, default: null, select: false },
            mutationState: { type: String, enum: Object.values(HAGO_FINANCIAL_MUTATION_STATES), default: null },
            claimedAt: { type: Date, default: null },
            sentAt: { type: Date, default: null },
            outcomeAt: { type: Date, default: null },
            providerTransactionId: { type: String, default: null, select: false },
            providerStatus: { type: String, default: null },
            providerCode: { type: String, default: null },
            lastReconciledAt: { type: Date, default: null },
            reconciliationAttempts: { type: Number, default: 0, min: 0 },
            unknownReason: { type: String, default: null },
        },

        /**
         * Number of status-check attempts made by the cron job.
         * When retryCount >= MAX_RETRY_COUNT the order is force-failed.
         */
        retryCount: {
            type: Number,
            default: 0,
            min: 0,
        },

        /** Timestamp of the most recent status poll. */
        lastCheckedAt: {
            type: Date,
            default: null,
        },

        /**
         * Idempotent refund guard.
         * Set to true BEFORE the wallet credit is applied.
         * If already true, a second refund attempt is rejected immediately.
         */
        refunded: {
            type: Boolean,
            default: false,
        },

        /**
         * Number of units the provider did NOT deliver.
         * Only meaningful when status === PARTIAL.
         * Used to calculate proportional refund: (remains / quantity) * chargedAmount.
         */
        remains: {
            type: Number,
            default: 0,
            min: [0, 'Remains cannot be negative'],
        },

        // ── Dynamic Order Fields ───────────────────────────────────────────────

        /**
         * Customer-supplied values for product-defined order fields.
         *
         * Stored ONCE at order creation time and never mutated afterward.
         * The snapshot ensures admin changes to product.orderFields do NOT
         * retroactively alter what was submitted or expected at order time.
         *
         * Structure:
         *   values         - key→value map of submitted field values
         *                    e.g. { player_id: "123", server: "EU" }
         *
         *   fieldsSnapshot - simplified copy of the product's active orderFields
         *                    at the moment the order was placed.
         *                    e.g. [{ key, label, type, options? }]
         *
         * Defaults to null when the product has no orderFields defined.
         */
        customerInput: {
            type: {
                /**
                 * Free-form key→value store.
                 * Keys match field.key; values are already type-coerced by
                 * the validator before being persisted here.
                 */
                values: {
                    type: mongoose.Schema.Types.Mixed,
                    default: {},
                },

                /**
                 * Immutable snapshot of the product's active orderFields at
                 * the moment of order creation.
                 * Each entry: { key, label, type, options?, placeholder? }
                 */
                fieldsSnapshot: {
                    type: [mongoose.Schema.Types.Mixed],
                    default: [],
                },
            },
            default: null,
        },

        /**
         * Backward/forward-compatible custom input payload snapshot.
         * Mirrors the validated values map used for dynamic product fields.
         */
        customInputs: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ groupIdSnapshot: 1 });

/** Idempotency enforcement — sparse because not all orders carry a key. */
orderSchema.index(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, sparse: true, name: 'unique_user_idempotency_key' }
);

orderSchema.index(
    { status: 1, providerCode: 1, 'hagoFinancial.mutationState': 1, 'hagoFinancial.lastReconciledAt': 1 },
    { name: 'hago_financial_reconciliation_queue' }
);

/**
 * Cron-job query index:
 * Efficiently find orders that are PROCESSING and have a provider order ID.
 * Groups by providerCode for the smart-polling loop.
 * Supports sorting by lastCheckedAt ASC (oldest-checked first).
 */
orderSchema.index(
    { status: 1, executionType: 1, providerCode: 1, providerOrderId: 1, lastCheckedAt: 1 },
    { name: 'processing_orders_poll_v2' }
);

const Order = mongoose.model('Order', orderSchema);

module.exports = {
    Order,
    ORDER_STATUS,
    ORDER_EXECUTION_TYPES,
    HAGO_FINANCIAL_MUTATION_STATES,
    MAX_RETRY_COUNT,
};
