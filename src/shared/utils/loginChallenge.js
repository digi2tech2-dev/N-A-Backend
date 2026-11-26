'use strict';
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');

module.exports = async (user) => {
    // Enable the global MFA requirement for legacy accounts before issuing OTP.
    // Saving the flag first revokes any previously issued non-MFA sessions.
    const mfaFlagMissing = Boolean(user.$isDefault?.('isTwoFactorEnabled'));
    if (!user.isTwoFactorEnabled || mfaFlagMissing) {
        user.isTwoFactorEnabled = true;
        if (mfaFlagMissing && user.markModified) user.markModified('isTwoFactorEnabled');
        await user.save();
    }
    const otp = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    user.twoFactorOtp = crypto.createHmac('sha256', config.jwt.secret).update(otp).digest('hex');
    user.twoFactorOtpExpires = new Date(Date.now() + 5 * 60 * 1000);
    user.twoFactorAttempts = 0;
    user.sessionVersion = String(user.sessionVersion || '0');
    if (user.markModified) user.markModified('sessionVersion');
    await user.save();
    await require('../../services/email.service').sendTwoFactorOtpEmail(user, otp);
    return {
        requires2FA: true,
        tempToken: jwt.sign({ id: user._id, purpose: '2fa-pending', sv: String(user.sessionVersion || '0') }, config.jwt.secret,
            { algorithm: 'HS256', expiresIn: '5m', jwtid: crypto.randomUUID() }),
        email: user.email,
    };
};
