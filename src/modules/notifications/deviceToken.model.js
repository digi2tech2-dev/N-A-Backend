'use strict';

const mongoose = require('mongoose');

const DEVICE_PLATFORM = Object.freeze({
    ANDROID: 'android',
});

const PUSH_PROVIDER = Object.freeze({
    FCM: 'fcm',
});

/**
 * One installation token can belong to only one account at a time. Keeping it
 * separate from User prevents the user document from growing without bound and
 * makes account switching an atomic ownership change.
 */
const deviceTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    token: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 20,
        maxlength: 4096,
        select: false,
    },
    platform: {
        type: String,
        enum: Object.values(DEVICE_PLATFORM),
        required: true,
    },
    provider: {
        type: String,
        enum: Object.values(PUSH_PROVIDER),
        required: true,
    },
    active: {
        type: Boolean,
        default: true,
        index: true,
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true,
    versionKey: false,
});

deviceTokenSchema.index({ userId: 1, active: 1, provider: 1, platform: 1 });

const DeviceToken = mongoose.model('DeviceToken', deviceTokenSchema);

module.exports = { DeviceToken, DEVICE_PLATFORM, PUSH_PROVIDER };
