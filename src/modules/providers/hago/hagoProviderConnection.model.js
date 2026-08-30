'use strict';

const mongoose = require('mongoose');

const CONNECTION_STATUS = Object.freeze({
    CONNECTED: 'CONNECTED',
    OTP_PENDING: 'OTP_PENDING',
    REAUTH_REQUIRED: 'REAUTH_REQUIRED',
    UNKNOWN: 'UNKNOWN',
});

const VALIDATION_STATUS = Object.freeze({
    VALID: 'VALID',
    REJECTED: 'REJECTED',
    UNKNOWN: 'UNKNOWN',
});

const pendingChallengeSchema = new mongoose.Schema({
    // All of this state is operational/internal. It is never serialized to an
    // admin client; the parent field is excluded from normal queries as well.
    challengeId: { type: String, required: true, trim: true },
    deviceId: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true },
    maskedIdentity: { type: String, default: null, trim: true },
    createdAt: { type: Date, required: true, default: Date.now },
}, { _id: false });

/**
 * A company-owned Hago session reference for one Provider. This is separate
 * from customers and products so later multi-account routing can add records
 * without redesigning the provider/order model.
 */
const hagoProviderConnectionSchema = new mongoose.Schema({
    provider: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Provider',
        required: true,
        index: true,
    },
    // Opaque upstream reference. It is not an auth credential, but is kept
    // backend-only because it authorizes use of the associated Hago session.
    connectionId: {
        type: String,
        trim: true,
        select: false,
    },
    label: {
        type: String,
        trim: true,
        maxlength: 100,
        default: 'Primary Hago account',
    },
    isPrimary: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    connectionStatus: {
        type: String,
        enum: Object.values(CONNECTION_STATUS),
        default: CONNECTION_STATUS.UNKNOWN,
    },
    lastValidatedAt: { type: Date, default: null },
    lastValidationStatus: {
        type: String,
        enum: [...Object.values(VALIDATION_STATUS), null],
        default: null,
    },
    lastSuccessfulAt: { type: Date, default: null },
    // Never selected by generic connection lookups or serialized directly.
    pendingChallenge: {
        type: pendingChallengeSchema,
        default: undefined,
        select: false,
    },
}, { timestamps: true });

// Company/provider lookup and one primary connection per provider. Sparse
// uniqueness makes connectionId unique only when an upstream session exists.
hagoProviderConnectionSchema.index({ provider: 1, isPrimary: 1 }, {
    unique: true,
    partialFilterExpression: { isPrimary: true },
});
hagoProviderConnectionSchema.index({ connectionId: 1 }, { unique: true, sparse: true });

const HagoProviderConnection = mongoose.model('HagoProviderConnection', hagoProviderConnectionSchema);

module.exports = {
    HagoProviderConnection,
    CONNECTION_STATUS,
    VALIDATION_STATUS,
};
