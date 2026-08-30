'use strict';

const mongoose = require('mongoose');

/**
 * Server-side, user-bound readiness quote. The opaque reference is the only
 * quote identifier exposed to the browser; upstream Hago data is never packed
 * into it.
 */
const hagoNobilityQuoteSchema = new mongoose.Schema({
    quoteRef: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    targetId: { type: String, required: true, select: false },
    selectedType: { type: Number, required: true, min: 1, max: 4 },
    selectedName: { type: String, required: true },
    operation: { type: String, required: true, enum: ['PURCHASE', 'RENEW'] },
    pricingBranch: { type: String, required: true, enum: ['purchase', 'renewal'] },
    branchBasePrice: { type: String, required: true },
    finalPrice: { type: String, required: true },
    usdAmount: { type: String, required: true },
    currency: { type: String, required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    markupPercentage: { type: Number, required: true, min: 0 },
    readinessAt: { type: Date, required: true },
    readinessConfigFingerprint: { type: String, required: true },
    connectionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'HagoProviderConnection', required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

hagoNobilityQuoteSchema.index({ userId: 1, productId: 1, expiresAt: 1 });

const HagoNobilityQuote = mongoose.model('HagoNobilityQuote', hagoNobilityQuoteSchema);

module.exports = { HagoNobilityQuote };
