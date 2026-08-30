'use strict';

const { Provider } = require('../provider.model');
const {
    HagoProviderConnection,
    CONNECTION_STATUS,
    VALIDATION_STATUS,
} = require('./hagoProviderConnection.model');
const { HagoClient, HagoClientError, sanitizePayload } = require('./hago.client');
const {
    AppError,
    BusinessRuleError,
    ConflictError,
    NotFoundError,
    ValidationError,
} = require('../../../shared/errors/AppError');

const HAGO_SLUG = 'hago';

const requireObject = (value, message) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(message);
    }
    return value;
};

const assertOnlyKeys = (value, allowed, message) => {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new ValidationError(message);
};

const validateChallengeRequest = (input) => {
    const value = requireObject(input, 'A Hago login challenge payload is required.');
    assertOnlyKeys(value, ['phone', 'countryCode', 'deviceId', 'country', 'language'], 'Unsupported Hago login challenge fields.');

    const phone = String(value.phone ?? '').trim();
    const countryCode = String(value.countryCode ?? '').trim();
    const deviceId = String(value.deviceId ?? '').trim();
    if (!/^\+?\d{8,18}$/.test(phone)) throw new ValidationError('phone must be a valid international phone number.');
    if (!/^\d{1,4}$/.test(countryCode)) throw new ValidationError('countryCode must contain 1 to 4 digits.');
    if (deviceId.length < 8 || deviceId.length > 256) throw new ValidationError('deviceId must be between 8 and 256 characters.');

    const result = { phone, countryCode, deviceId };
    if (value.country !== undefined) {
        const country = String(value.country).trim();
        if (!/^[A-Z]{2}$/.test(country)) throw new ValidationError('country must be a two-letter uppercase country code.');
        result.country = country;
    }
    if (value.language !== undefined) {
        const language = String(value.language).trim();
        if (!language) throw new ValidationError('language cannot be empty.');
        result.language = language;
    }
    return result;
};

const validateOtpRequest = (input) => {
    const value = requireObject(input, 'An OTP payload is required.');
    assertOnlyKeys(value, ['otp'], 'Unsupported Hago OTP verification fields.');
    const otp = String(value.otp ?? '').trim();
    if (!otp) throw new ValidationError('otp is required.');
    return otp;
};

const maskIdentity = (phone) => {
    const normalized = String(phone ?? '').replace(/\D/g, '');
    return normalized.length >= 4 ? `••••${normalized.slice(-4)}` : '••••';
};

const toDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const isValidPendingChallenge = (pendingChallenge, now = new Date()) => {
    const challengeId = String(pendingChallenge?.challengeId ?? '').trim();
    const expiresAt = toDate(pendingChallenge?.expiresAt);
    return Boolean(challengeId && expiresAt && expiresAt > now);
};

const normalizeSession = (response) => {
    const upstream = String(response?.session?.status ?? 'UNKNOWN').toUpperCase();
    if (upstream === VALIDATION_STATUS.VALID) {
        return { upstreamStatus: VALIDATION_STATUS.VALID, connectionStatus: CONNECTION_STATUS.CONNECTED };
    }
    if (upstream === VALIDATION_STATUS.REJECTED) {
        return { upstreamStatus: VALIDATION_STATUS.REJECTED, connectionStatus: CONNECTION_STATUS.REAUTH_REQUIRED };
    }
    return { upstreamStatus: VALIDATION_STATUS.UNKNOWN, connectionStatus: CONNECTION_STATUS.UNKNOWN };
};

const serializeConnection = (connection, { includePending = true } = {}) => {
    if (!connection) return null;
    const pending = connection.pendingChallenge;
    return {
        label: connection.label,
        isPrimary: Boolean(connection.isPrimary),
        enabled: Boolean(connection.enabled),
        // Informational only: callers need to distinguish a local placeholder
        // from an opaque upstream connection without receiving its identifier.
        hasConnection: Boolean(connection.connectionId),
        connectionStatus: connection.connectionStatus,
        lastValidatedAt: connection.lastValidatedAt ?? null,
        lastValidationStatus: connection.lastValidationStatus ?? null,
        lastSuccessfulAt: connection.lastSuccessfulAt ?? null,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
        ...(includePending && isValidPendingChallenge(pending) ? {
            pendingLogin: {
                status: CONNECTION_STATUS.OTP_PENDING,
                expiresAt: pending.expiresAt,
                maskedIdentity: pending.maskedIdentity ?? null,
            },
        } : {}),
    };
};

const normalizeIdentity = (response, targetId = undefined) => {
    const safe = sanitizePayload(response);
    const identity = safe?.identity ?? safe?.user ?? safe?.target ?? safe?.data ?? safe;
    return {
        ...(targetId === undefined ? {} : { targetId: String(targetId).trim() }),
        uid: identity?.uid ?? identity?.userId ?? identity?.id ?? null,
        nickName: identity?.nickName ?? identity?.nickname ?? identity?.name ?? null,
        avatar: identity?.avatar ?? null,
    };
};

const normalizeWallet = (response) => {
    const balances = sanitizePayload(response)?.wallet?.balances ?? {};
    const numberOrNull = (value) => Number.isFinite(value) ? value : null;
    return {
        hagoDiamond: numberOrNull(balances.hagoDiamond),
        hagoDiamondNew: numberOrNull(balances.hagoDiamondNew),
        hagoCrystal: numberOrNull(balances.hagoCrystal),
    };
};

class HagoConnectionService {
    constructor({ providerModel = Provider, connectionModel = HagoProviderConnection, client = new HagoClient() } = {}) {
        this.Provider = providerModel;
        this.Connection = connectionModel;
        this.client = client;
    }

    async getHagoProvider(providerId) {
        const provider = await this.Provider.findById(providerId);
        if (!provider || provider.deletedAt) throw new NotFoundError('Provider');
        if (provider.slug !== HAGO_SLUG) {
            throw new BusinessRuleError('This endpoint is available only for the Hago provider.', 'HAGO_PROVIDER_REQUIRED');
        }
        return provider;
    }

    async _primaryConnection(providerId) {
        return this.Connection.findOne({ provider: providerId, isPrimary: true })
            .select('+connectionId +pendingChallenge');
    }

    async _primaryConnectionOrThrow(providerId) {
        const connection = await this._primaryConnection(providerId);
        if (!connection?.connectionId || !connection.enabled) {
            throw new BusinessRuleError('No enabled Hago connection is available.', 'HAGO_CONNECTION_UNAVAILABLE');
        }
        return connection;
    }

    async _findOrCreatePrimary(providerId) {
        const existing = await this._primaryConnection(providerId);
        if (existing) return existing;
        try {
            return await this.Connection.create({
                provider: providerId,
                isPrimary: true,
                enabled: true,
                // A local record alone does not mean Hago accepted a login
                // challenge. OTP_PENDING is reserved for a valid persisted
                // pendingChallenge created after an upstream success.
                connectionStatus: CONNECTION_STATUS.UNKNOWN,
            });
        } catch (error) {
            if (error?.code !== 11000) throw error;
            return this._primaryConnection(providerId);
        }
    }

    async _normalizeDisconnectedOtpPending(connection, { ignoreSaveError = false } = {}) {
        const isStaleOtpPending = !connection?.connectionId
            && !connection?.pendingChallenge
            && connection.connectionStatus === CONNECTION_STATUS.OTP_PENDING;
        if (!isStaleOtpPending) return false;

        connection.connectionStatus = CONNECTION_STATUS.UNKNOWN;
        try {
            await connection.save();
        } catch (error) {
            // This is used while preserving an upstream error. Never let a
            // best-effort local cleanup hide the original Hago failure.
            if (!ignoreSaveError) throw error;
        }
        return true;
    }

    async _clearInvalidPendingChallenge(connection, now = new Date()) {
        if (!connection?.pendingChallenge || isValidPendingChallenge(connection.pendingChallenge, now)) {
            return false;
        }

        connection.pendingChallenge = undefined;
        // A stale OTP state must not imply that verification is still
        // possible. Preserve any usable opaque connectionId on reconnect.
        if (!connection.connectionId || connection.connectionStatus === CONNECTION_STATUS.OTP_PENDING) {
            connection.connectionStatus = CONNECTION_STATUS.UNKNOWN;
        }
        await connection.save();
        return true;
    }

    _safeHagoError(error, operation) {
        if (error instanceof AppError) return error;
        if (error instanceof HagoClientError) {
            const statusCode = error.code === 'HAGO_UPSTREAM_TIMEOUT' ? 504
                : error.code === 'HAGO_UPSTREAM_UNAVAILABLE' ? 503
                    : error.code === 'HAGO_CONFIGURATION_ERROR' ? 503
                        : 502;
            return new AppError(`Hago ${operation} is unavailable.`, statusCode, error.code);
        }
        return new AppError(`Hago ${operation} is unavailable.`, 502, 'HAGO_REQUEST_FAILED');
    }

    async createLoginChallenge(providerId, input) {
        await this.getHagoProvider(providerId);
        const request = validateChallengeRequest(input);
        const connection = await this._findOrCreatePrimary(providerId);
        await this._normalizeDisconnectedOtpPending(connection);
        const now = new Date();
        await this._clearInvalidPendingChallenge(connection, now);
        const pending = connection.pendingChallenge;
        if (isValidPendingChallenge(pending, now)) {
            throw new ConflictError('A Hago login challenge is already pending.');
        }

        let upstream;
        try {
            upstream = await this.client.createLoginChallenge(request);
        } catch (error) {
            await this._normalizeDisconnectedOtpPending(connection, { ignoreSaveError: true });
            throw this._safeHagoError(error, 'login challenge creation');
        }

        const expiresAt = toDate(upstream?.expiresAt);
        const challengeId = String(upstream?.challengeId ?? '').trim();
        if (!challengeId || !expiresAt || expiresAt <= now) {
            await this._normalizeDisconnectedOtpPending(connection, { ignoreSaveError: true });
            throw new AppError('Hago returned an invalid login challenge.', 502, 'HAGO_INVALID_CHALLENGE_RESPONSE');
        }

        connection.pendingChallenge = {
            challengeId,
            deviceId: request.deviceId,
            expiresAt,
            maskedIdentity: maskIdentity(request.phone),
            createdAt: now,
        };
        // A reconnect must continue reporting the existing usable state until
        // a later OTP verification atomically changes its connectionId.
        if (!connection.connectionId) connection.connectionStatus = CONNECTION_STATUS.OTP_PENDING;
        await connection.save();

        return { connection: serializeConnection(connection) };
    }

    async verifyLoginChallenge(providerId, input) {
        await this.getHagoProvider(providerId);
        const otp = validateOtpRequest(input);
        const connection = await this._primaryConnection(providerId);
        const pending = connection?.pendingChallenge;
        if (!connection || !pending) {
            throw new BusinessRuleError('No Hago login challenge is pending.', 'HAGO_LOGIN_CHALLENGE_NOT_FOUND');
        }
        if (!isValidPendingChallenge(pending)) {
            await this._clearInvalidPendingChallenge(connection);
            throw new BusinessRuleError('The Hago login challenge has expired.', 'HAGO_LOGIN_CHALLENGE_EXPIRED');
        }

        let upstream;
        try {
            upstream = await this.client.verifyLoginChallenge(pending.challengeId, {
                otp,
                deviceId: pending.deviceId,
            });
        } catch (error) {
            // Preserve both the still-valid challenge and any older active
            // connection; no OTP is ever assigned to a document.
            throw this._safeHagoError(error, 'OTP verification');
        }

        const connectionId = String(upstream?.connection?.connectionId ?? '').trim();
        if (!connectionId) {
            throw new AppError('Hago returned an invalid connection response.', 502, 'HAGO_INVALID_CONNECTION_RESPONSE');
        }

        const updated = await this.Connection.findOneAndUpdate(
            { _id: connection._id, 'pendingChallenge.challengeId': pending.challengeId },
            {
                $set: {
                    connectionId,
                    isPrimary: true,
                    enabled: true,
                    connectionStatus: CONNECTION_STATUS.CONNECTED,
                    lastSuccessfulAt: new Date(),
                },
                $unset: { pendingChallenge: 1 },
            },
            { new: true, runValidators: true }
        ).select('+pendingChallenge');

        if (!updated) {
            throw new ConflictError('The Hago login challenge changed before verification completed.');
        }
        return { connection: serializeConnection(updated) };
    }

    async getConnection(providerId) {
        await this.getHagoProvider(providerId);
        const connection = await this._primaryConnection(providerId);
        await this._clearInvalidPendingChallenge(connection);
        return { connection: serializeConnection(connection) };
    }

    async validateSession(providerId) {
        await this.getHagoProvider(providerId);
        const connection = await this._primaryConnectionOrThrow(providerId);
        const checkedAt = new Date();
        try {
            const upstream = await this.client.sessionValidation(connection.connectionId);
            const normalized = normalizeSession(upstream);
            connection.lastValidatedAt = checkedAt;
            connection.lastValidationStatus = normalized.upstreamStatus;
            connection.connectionStatus = normalized.connectionStatus;
            await connection.save();
            return { connection: serializeConnection(connection), session: normalized };
        } catch (error) {
            connection.lastValidatedAt = checkedAt;
            connection.lastValidationStatus = VALIDATION_STATUS.UNKNOWN;
            connection.connectionStatus = CONNECTION_STATUS.UNKNOWN;
            await connection.save();
            throw this._safeHagoError(error, 'session validation');
        }
    }

    async getReadiness(providerId) {
        await this.getHagoProvider(providerId);
        try {
            const response = await this.client.readiness();
            return { readiness: { status: String(response?.status ?? 'UNKNOWN').toUpperCase() } };
        } catch (error) {
            throw this._safeHagoError(error, 'readiness check');
        }
    }

    async getAgentProfile(providerId) {
        await this.getHagoProvider(providerId);
        const connection = await this._primaryConnectionOrThrow(providerId);
        try {
            return { profile: normalizeIdentity(await this.client.agentProfile(connection.connectionId)) };
        } catch (error) {
            throw this._safeHagoError(error, 'agent profile lookup');
        }
    }

    async getWalletBalance(providerId) {
        await this.getHagoProvider(providerId);
        const connection = await this._primaryConnectionOrThrow(providerId);
        try {
            return { wallet: normalizeWallet(await this.client.walletBalance(connection.connectionId)) };
        } catch (error) {
            throw this._safeHagoError(error, 'wallet balance lookup');
        }
    }

    async verifyTarget(providerId, input) {
        await this.getHagoProvider(providerId);
        const value = requireObject(input, 'A Hago target verification payload is required.');
        assertOnlyKeys(value, ['targetId'], 'Unsupported Hago target verification fields.');
        const targetId = String(value.targetId ?? '').trim();
        if (!targetId) throw new ValidationError('targetId is required.');
        const connection = await this._primaryConnectionOrThrow(providerId);
        try {
            return { verification: normalizeIdentity(await this.client.verifyTarget(connection.connectionId, targetId), targetId) };
        } catch (error) {
            throw this._safeHagoError(error, 'target verification');
        }
    }
}

const hagoConnectionService = new HagoConnectionService();

module.exports = {
    HagoConnectionService,
    hagoConnectionService,
    serializeConnection,
    normalizeSession,
    validateChallengeRequest,
    validateOtpRequest,
};
