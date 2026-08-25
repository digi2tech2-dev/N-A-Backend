'use strict';

const { OAuth2Client } = require('google-auth-library');
const config = require('../../config/config');
const { AppError } = require('../../shared/errors/AppError');
const { resolveGoogleUser } = require('./googleOAuth.service');
const { loginWithGoogle } = require('./auth.service');

const googleTokenClient = new OAuth2Client();
const TRUSTED_GOOGLE_ISSUERS = new Set([
    'accounts.google.com',
    'https://accounts.google.com',
]);

const nativeGoogleConfigurationError = () => new AppError(
    'Native Google sign-in is not configured on this server.',
    503,
    'GOOGLE_NATIVE_AUTH_NOT_CONFIGURED'
);

const invalidGoogleCredentialError = () => new AppError(
    'Google credential is invalid or expired. Please try again.',
    401,
    'INVALID_GOOGLE_CREDENTIAL'
);

/**
 * Verify a Google ID token independently of the mobile client. The Google
 * library validates the token signature, certificate chain, issuer, audience,
 * and expiry before this service accepts any identity claims.
 */
const verifyNativeGoogleIdToken = async (idToken) => {
    if (!config.google.clientId) throw nativeGoogleConfigurationError();

    let ticket;
    try {
        ticket = await googleTokenClient.verifyIdToken({
            idToken,
            audience: config.google.clientId,
        });
    } catch (_) {
        throw invalidGoogleCredentialError();
    }

    const payload = ticket.getPayload();
    const email = String(payload?.email || '').trim().toLowerCase();
    const emailVerified = payload?.email_verified === true || payload?.email_verified === 'true';

    // These checks are intentionally explicit as a defense in depth around the
    // verifier boundary. Nothing supplied by the frontend is used here.
    if (
        !payload
        || !TRUSTED_GOOGLE_ISSUERS.has(payload.iss)
        || payload.aud !== config.google.clientId
        || !payload.sub
        || !email
    ) {
        throw invalidGoogleCredentialError();
    }

    if (!emailVerified) {
        throw new AppError(
            'Your Google email address is not verified.',
            401,
            'GOOGLE_EMAIL_NOT_VERIFIED'
        );
    }

    return {
        id: String(payload.sub),
        displayName: String(payload.name || '').trim() || email.split('@')[0],
        emails: [{ value: email }],
    };
};

/**
 * Reuses the same account-linking, account creation, status, onboarding, and
 * JWT/profile-completion logic as the browser Passport callback.
 */
const loginWithNativeGoogle = async ({ idToken }) => {
    const verifiedProfile = await verifyNativeGoogleIdToken(idToken);
    const { user } = await resolveGoogleUser(verifiedProfile);
    return loginWithGoogle(user);
};

module.exports = {
    verifyNativeGoogleIdToken,
    loginWithNativeGoogle,
};
