'use strict';

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://inchill-api.digiteech.me';
const DEFAULT_TIMEOUT_MS = 25_000;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token|session)/i;

const sanitizePayload = (value) => {
    if (Array.isArray(value)) return value.map(sanitizePayload);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => (
        SENSITIVE_KEY.test(key) ? [] : [[key, sanitizePayload(nested)]]
    )));
};

class InchillClientError extends Error {
    constructor(message, { code = 'INCHILL_PROVIDER_UNAVAILABLE', statusCode = null } = {}) {
        super(message);
        this.name = 'InchillClientError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

const positiveNumber = (value, code = 'INCHILL_INVALID_AMOUNT') => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) throw new InchillClientError('A positive amount is required.', { code, statusCode: 400 });
    return amount;
};

class InchillClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl ?? process.env.INCHILL_API_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
        this.apiKey = options.apiKey ?? process.env.INCHILL_INTERNAL_API_KEY ?? '';
        this.timeout = Number(options.timeoutMs ?? process.env.INCHILL_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
        this.http = options.httpClient ?? axios.create({ baseURL: this.baseUrl, timeout: this.timeout, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    }

    _headers(extra = {}) {
        if (!this.apiKey) throw new InchillClientError('Inchill API credentials are not configured.', { code: 'INCHILL_PROVIDER_UNAVAILABLE', statusCode: 503 });
        return { 'x-internal-api-key': this.apiKey, ...extra };
    }

    _error(error, operation) {
        if (error instanceof InchillClientError) return error;
        const statusCode = error?.response?.status ?? null;
        const payload = error?.response?.data ?? {};
        const upstreamCode = String(payload?.code ?? '').toUpperCase();
        if (statusCode === 429) return new InchillClientError('Inchill rate limited the request.', { code: 'INCHILL_RATE_LIMITED', statusCode });
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message ?? ''))) return new InchillClientError(`Inchill ${operation} timed out.`, { code: 'INCHILL_TIMEOUT', statusCode: statusCode ?? 504 });
        if (upstreamCode === 'OTP_EXPIRED') return new InchillClientError('The OTP has expired.', { code: 'INCHILL_OTP_EXPIRED', statusCode });
        if (/OTP|CODE/.test(upstreamCode)) return new InchillClientError('The OTP is invalid.', { code: 'INCHILL_OTP_INVALID', statusCode });
        if ((statusCode === 400 || statusCode === 404) && /target|preflight/i.test(operation)) return new InchillClientError(`Inchill ${operation} was rejected.`, { code: 'INCHILL_TARGET_INVALID', statusCode });
        if (statusCode >= 400 && statusCode < 500) return new InchillClientError(`Inchill ${operation} was rejected.`, { code: 'INCHILL_REQUEST_REJECTED', statusCode });
        return new InchillClientError(`Inchill ${operation} is unavailable.`, { code: 'INCHILL_PROVIDER_UNAVAILABLE', statusCode: statusCode ?? 502 });
    }

    async _post(path, body, operation, headers = {}, { preserveFinancial = false } = {}) {
        try {
            const response = await this.http.post(path, body, { headers: this._headers(headers) });
            return { statusCode: response.status, data: sanitizePayload(response.data ?? {}) };
        } catch (error) {
            if (preserveFinancial && error?.response) return { statusCode: error.response.status, data: sanitizePayload(error.response.data ?? {}) };
            throw this._error(error, operation);
        }
    }

    sendOtp({ phone, countryCode }) { return this._post('/api/auth/send-otp', { phone, countryCode }, 'OTP request'); }
    verifyOtp({ phone, otp, deviceId, country, language }) {
        const body = { phone, otp, deviceId };
        if (country) body.country = country;
        if (language) body.language = language;
        return this._post('/api/auth/verify-otp', body, 'OTP verification');
    }
    validateSession(agentPhone) { return this._post('/api/bot/session/validate', { agentPhone }, 'session validation'); }
    getAgentProfile(agentPhone) { return this._post('/api/bot/agent-profile', { agentPhone }, 'agent profile lookup'); }
    getWalletBalance(agentPhone) { return this._post('/api/bot/wallet-balance', { agentPhone }, 'wallet lookup'); }
    verifyTarget(agentPhone, targetId) { return this._post('/api/bot/verify-id', { agentPhone, targetId }, 'target lookup'); }
    getTransferReadiness(agentPhone) { return this._post('/api/bot/transfer-readiness', { agentPhone }, 'transfer readiness'); }
    rechargePreflight(agentPhone, targetId, amount) { return this._post('/api/bot/recharge/preflight', { agentPhone, targetId, amount: positiveNumber(amount) }, 'recharge preflight'); }
    rechargeDiamond(agentPhone, targetId, amount, idempotencyKey) {
        return this._post('/api/bot/recharge/diamond', { agentPhone, targetId, amount: positiveNumber(amount) }, 'Diamond recharge', { 'Idempotency-Key': idempotencyKey, 'X-Controlled-Mutation': 'true' }, { preserveFinancial: true });
    }
    reconcileRecharge(agentPhone, transactionId, history = {}) { return this._post('/api/bot/recharge/reconcile', { agentPhone, transactionId, ...history }, 'reconciliation'); }
    getTransactions(agentPhone) { return this._post('/api/bot/transactions', { agentPhone }, 'transaction lookup'); }
}

module.exports = { InchillClient, InchillClientError, sanitizePayload, positiveNumber, DEFAULT_BASE_URL };
