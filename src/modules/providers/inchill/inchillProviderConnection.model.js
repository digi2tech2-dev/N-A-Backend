'use strict';
const mongoose = require('mongoose');
const CONNECTION_STATUS = Object.freeze({ CONNECTED: 'CONNECTED', OTP_PENDING: 'OTP_PENDING', REAUTH_REQUIRED: 'REAUTH_REQUIRED', UNKNOWN: 'UNKNOWN' });
const schema = new mongoose.Schema({
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
    agentPhone: { type: String, trim: true, select: false, default: null },
    countryCode: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    language: { type: String, trim: true, default: null },
    label: { type: String, trim: true, maxlength: 100, default: 'Primary Inchill agent' },
    isPrimary: { type: Boolean, default: true }, enabled: { type: Boolean, default: true },
    connectionStatus: { type: String, enum: Object.values(CONNECTION_STATUS), default: CONNECTION_STATUS.UNKNOWN },
    lastValidatedAt: { type: Date, default: null }, lastValidationStatus: { type: String, enum: ['VALID', 'REJECTED', 'UNKNOWN', null], default: null }, lastSuccessfulAt: { type: Date, default: null },
    pendingLogin: { phone: { type: String, select: false }, countryCode: { type: String, select: false }, deviceId: { type: String, select: false }, country: { type: String, select: false }, language: { type: String, select: false }, expiresAt: { type: Date, select: false } },
}, { timestamps: true });
schema.index({ provider: 1, isPrimary: 1 }, { unique: true, partialFilterExpression: { isPrimary: true } });
module.exports = { InchillProviderConnection: mongoose.model('InchillProviderConnection', schema), INCHILL_CONNECTION_STATUS: CONNECTION_STATUS };
