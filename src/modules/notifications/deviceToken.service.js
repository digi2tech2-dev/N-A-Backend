'use strict';

const { DeviceToken, DEVICE_PLATFORM, PUSH_PROVIDER } = require('./deviceToken.model');

const registerDeviceToken = async ({ userId, token, platform, provider }) => {
    const now = new Date();
    return DeviceToken.findOneAndUpdate(
        { token },
        {
            $set: {
                userId,
                platform,
                provider,
                active: true,
                lastSeenAt: now,
            },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
};

const unregisterDeviceToken = async ({ userId, token }) => {
    const result = await DeviceToken.updateOne(
        { userId, token, active: true },
        { $set: { active: false, lastSeenAt: new Date() } }
    );
    return { deactivated: result.modifiedCount > 0 };
};

const getActiveTokensForUser = async (userId) => DeviceToken.find({
    userId,
    active: true,
    platform: DEVICE_PLATFORM.ANDROID,
    provider: PUSH_PROVIDER.FCM,
}).select('+token').lean();

const deactivateTokens = async (tokens = []) => {
    const uniqueTokens = [...new Set(tokens.filter(Boolean))];
    if (!uniqueTokens.length) return { deactivated: 0 };
    const result = await DeviceToken.updateMany(
        { token: { $in: uniqueTokens }, active: true },
        { $set: { active: false, lastSeenAt: new Date() } }
    );
    return { deactivated: result.modifiedCount };
};

module.exports = {
    registerDeviceToken,
    unregisterDeviceToken,
    getActiveTokensForUser,
    deactivateTokens,
};
