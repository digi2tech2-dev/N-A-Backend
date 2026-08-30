'use strict';

/**
 * Hago V2 read-only client.
 *
 * This module intentionally exposes no auto-recharge operation. It is a
 * server-only integration: authentication always comes from HAGO_API_KEY and
 * is never read from Provider records.
 */

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://hago-api.digiteech.me';
const DEFAULT_TIMEOUT_MS = 25_000;

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;

const sanitizePayload = (value) => {
    if (Array.isArray(value)) return value.map(sanitizePayload);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => {
        if (SENSITIVE_KEY.test(key)) return [];
        // V2 documents session.status as safe diagnostic state. Keep only that
        // narrow status shape rather than retaining any potential session data.
        if (key === 'session' && nested && typeof nested === 'object') {
            return [['session', { status: nested.status ?? null }]];
        }
        return [[key, sanitizePayload(nested)]];
    }));
};

class HagoClientError extends Error {
    constructor(message, { code = 'HAGO_REQUEST_FAILED', statusCode = null } = {}) {
        super(message);
        this.name = 'HagoClientError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

const parseTimeout = (value) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};

const requireOpaqueId = (value, label) => {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        const codeLabel = String(label)
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_');
        throw new HagoClientError(`${label} is required.`, { code: `HAGO_${codeLabel}_REQUIRED` });
    }
    return normalized;
};

const requirePositiveAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new HagoClientError('amount must be a positive number.', { code: 'HAGO_INVALID_AMOUNT' });
    }
    return amount;
};

const requireNobilityType = (value) => {
    const nobilityType = Number(value);
    if (!Number.isInteger(nobilityType) || nobilityType < 1 || nobilityType > 4) {
        throw new HagoClientError('nobilityType must be an integer between 1 and 4.', { code: 'HAGO_INVALID_NOBILITY_TYPE' });
    }
    return nobilityType;
};

const requireLoginPhone = (value) => {
    const phone = String(value ?? '').trim();
    if (!/^\+?\d{8,18}$/.test(phone)) {
        throw new HagoClientError('phone must be a valid international phone number.', { code: 'HAGO_INVALID_PHONE' });
    }
    return phone;
};

const requireCountryCode = (value) => {
    const countryCode = String(value ?? '').trim();
    if (!/^\d{1,4}$/.test(countryCode)) {
        throw new HagoClientError('countryCode must contain 1 to 4 digits.', { code: 'HAGO_INVALID_COUNTRY_CODE' });
    }
    return countryCode;
};

const requireDeviceId = (value) => {
    const deviceId = String(value ?? '').trim();
    if (deviceId.length < 8 || deviceId.length > 256) {
        throw new HagoClientError('deviceId must be between 8 and 256 characters.', { code: 'HAGO_INVALID_DEVICE_ID' });
    }
    return deviceId;
};

const requireOtp = (value) => {
    const otp = String(value ?? '').trim();
    if (!otp) {
        throw new HagoClientError('otp is required.', { code: 'HAGO_OTP_REQUIRED' });
    }
    return otp;
};

class HagoClient {
    constructor(options = {}) {
        const configuredBaseUrl = options.baseUrl ?? process.env.HAGO_API_BASE_URL ?? DEFAULT_BASE_URL;
        const baseUrl = String(configuredBaseUrl).trim().replace(/\/+$/, '');

        if (!baseUrl) {
            throw new HagoClientError('Hago API base URL is not configured.', { code: 'HAGO_CONFIGURATION_ERROR' });
        }

        this.baseUrl = baseUrl;
        this.apiKey = options.apiKey ?? process.env.HAGO_API_KEY ?? '';
        this.timeout = parseTimeout(options.timeoutMs ?? process.env.HAGO_API_TIMEOUT_MS);
        this._client = options.httpClient ?? axios.create({
            baseURL: this.baseUrl,
            timeout: this.timeout,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    }

    _authHeaders() {
        if (!this.apiKey) {
            throw new HagoClientError('Hago API key is not configured.', { code: 'HAGO_CONFIGURATION_ERROR' });
        }
        return { 'x-client-api-key': this.apiKey };
    }

    _normalizeError(error, operation) {
        if (error instanceof HagoClientError) return error;

        const statusCode = error?.response?.status ?? error?.statusCode ?? null;
        const timedOut = error?.code === 'ECONNABORTED'
            || error?.code === 'ETIMEDOUT'
            || /timeout/i.test(String(error?.message ?? ''));

        if (timedOut) {
            return new HagoClientError(`Hago ${operation} timed out.`, {
                code: 'HAGO_UPSTREAM_TIMEOUT',
                statusCode,
            });
        }

        if (statusCode && statusCode >= 500) {
            return new HagoClientError(`Hago ${operation} is temporarily unavailable.`, {
                code: 'HAGO_UPSTREAM_UNAVAILABLE',
                statusCode,
            });
        }

        return new HagoClientError(`Hago ${operation} failed.`, {
            code: 'HAGO_REQUEST_FAILED',
            statusCode,
        });
    }

    async _get(path, operation) {
        try {
            const response = await this._client.get(path);
            return sanitizePayload(response?.data ?? null);
        } catch (error) {
            throw this._normalizeError(error, operation);
        }
    }

    async _post(path, body, operation) {
        try {
            const response = await this._client.post(path, body, {
                headers: this._authHeaders(),
            });
            return sanitizePayload(response?.data ?? null);
        } catch (error) {
            throw this._normalizeError(error, operation);
        }
    }

    health() { return this._get('/health', 'health check'); }

    readiness() { return this._get('/ready', 'readiness check'); }

    createLoginChallenge({ phone, countryCode, deviceId, country, language }) {
        const body = {
            phone: requireLoginPhone(phone),
            countryCode: requireCountryCode(countryCode),
            deviceId: requireDeviceId(deviceId),
        };
        if (country !== undefined) {
            const normalizedCountry = String(country).trim();
            if (!/^[A-Z]{2}$/.test(normalizedCountry)) {
                throw new HagoClientError('country must be a two-letter uppercase country code.', { code: 'HAGO_INVALID_COUNTRY' });
            }
            body.country = normalizedCountry;
        }
        if (language !== undefined) {
            const normalizedLanguage = String(language).trim();
            if (!normalizedLanguage) {
                throw new HagoClientError('language cannot be empty.', { code: 'HAGO_INVALID_LANGUAGE' });
            }
            body.language = normalizedLanguage;
        }
        return this._post('/api/v2/login-challenges', body, 'login challenge creation');
    }

    verifyLoginChallenge(challengeId, { otp, deviceId }) {
        return this._post(`/api/v2/login-challenges/${encodeURIComponent(requireOpaqueId(challengeId, 'challengeId'))}/verify`, {
            otp: requireOtp(otp),
            deviceId: requireDeviceId(deviceId),
        }, 'login challenge verification');
    }

    sessionValidation(connectionId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/session/validate`, {}, 'session validation');
    }

    walletBalance(connectionId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/wallet-balance`, {}, 'wallet balance lookup');
    }

    agentProfile(connectionId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/agent-profile`, {}, 'agent profile lookup');
    }

    verifyTarget(connectionId, targetId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/verify-id`, {
            targetId: requireOpaqueId(targetId, 'targetId'),
        }, 'target verification');
    }

    accountHistory(connectionId, query = {}) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/account-history`, sanitizePayload(query), 'account history lookup');
    }

    transferReadiness(connectionId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/transfer-readiness`, {}, 'transfer readiness lookup');
    }

    nobilityReadiness(connectionId, targetId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/nobility-readiness`, {
            targetId: requireOpaqueId(targetId, 'targetId'),
        }, 'nobility readiness lookup');
    }

    nobilityPurchaseReadiness(connectionId, targetId, nobilityType) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/nobility-purchase-readiness`, {
            targetId: requireOpaqueId(targetId, 'targetId'),
            nobilityType: requireNobilityType(nobilityType),
        }, 'nobility purchase readiness lookup');
    }

    diamondPreview(connectionId, amount) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/previews/diamond`, {
            amount: requirePositiveAmount(amount),
        }, 'diamond preview');
    }

    crystalPreview(connectionId, amount) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/previews/crystal`, {
            amount: requirePositiveAmount(amount),
        }, 'crystal preview');
    }

    nobilityPreview(connectionId, targetId, nobilityType) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/previews/nobility`, {
            targetId: requireOpaqueId(targetId, 'targetId'),
            nobilityType: requireNobilityType(nobilityType),
        }, 'nobility preview');
    }

    listTransactions(connectionId) {
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/transactions`, {}, 'transaction lookup');
    }

    async lookupTransaction(connectionId, transactionId) {
        const normalizedTransactionId = requireOpaqueId(transactionId, 'transactionId');
        const result = await this.listTransactions(connectionId);
        const transactions = Array.isArray(result?.transactions) ? result.transactions : [];
        return transactions.find((transaction) => String(transaction?.id ?? '') === normalizedTransactionId) ?? null;
    }

    reconcileTransaction(connectionId, transactionId, history = undefined) {
        const body = { transactionId: requireOpaqueId(transactionId, 'transactionId') };
        if (history !== undefined) body.history = sanitizePayload(history);
        return this._post(`/api/v2/connections/${encodeURIComponent(requireOpaqueId(connectionId, 'connectionId'))}/transactions/reconcile`, body, 'transaction reconciliation');
    }
}

module.exports = {
    HagoClient,
    HagoClientError,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    sanitizePayload,
};
