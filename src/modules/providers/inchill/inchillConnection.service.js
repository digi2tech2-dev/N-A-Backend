'use strict';

const { Provider } = require('../provider.model');
const { InchillProviderConnection, INCHILL_CONNECTION_STATUS } = require('./inchillProviderConnection.model');
const { InchillClient, InchillClientError } = require('./inchill.client');
const { AppError, BusinessRuleError, NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

const OTP_TTL_MS = 10 * 60 * 1000;
const phone = (value) => { const normalized = String(value ?? '').trim(); if (!/^\+?\d{8,18}$/.test(normalized)) throw new ValidationError('phone must be a valid international phone number.'); return normalized; };
const countryCode = (value) => { const normalized = String(value ?? '').trim(); if (!/^\d{1,4}$/.test(normalized)) throw new ValidationError('countryCode must contain 1 to 4 digits.'); return normalized; };
const deviceId = (value) => { const normalized = String(value ?? '').trim(); if (normalized.length < 8 || normalized.length > 256) throw new ValidationError('deviceId must be between 8 and 256 characters.'); return normalized; };
const serialize = (connection) => connection ? ({ label: connection.label, isPrimary: Boolean(connection.isPrimary), enabled: Boolean(connection.enabled), hasConnection: Boolean(connection.agentPhone), connectionStatus: connection.connectionStatus, lastValidatedAt: connection.lastValidatedAt ?? null, lastValidationStatus: connection.lastValidationStatus ?? null, lastSuccessfulAt: connection.lastSuccessfulAt ?? null, pendingLogin: connection.pendingLogin?.expiresAt > new Date() ? { status: 'OTP_PENDING', expiresAt: connection.pendingLogin.expiresAt } : null }) : null;
const normalizeIdentity = (data, targetId = null) => {
    const user = data?.userInfo ?? data?.agentProfile ?? {};
    return { ...(targetId ? { targetId: String(targetId) } : {}), vid: user?.vid == null ? null : String(user.vid), nickName: user?.nick ?? null, country: user?.country ?? null };
};
const normalizeWallet = (data) => ({ diamond: Number.isFinite(Number(data?.wallet?.balances?.hagoDiamond)) ? Number(data.wallet.balances.hagoDiamond) : null, diamondNew: Number.isFinite(Number(data?.wallet?.balances?.hagoDiamondNew)) ? Number(data.wallet.balances.hagoDiamondNew) : null });

class InchillConnectionService {
    constructor({ providerModel = Provider, connectionModel = InchillProviderConnection, client = new InchillClient(), now = () => new Date() } = {}) { this.Provider = providerModel; this.Connection = connectionModel; this.client = client; this.now = now; }
    async _provider(id) { const provider = await this.Provider.findById(id); if (!provider || provider.deletedAt) throw new NotFoundError('Provider'); if (provider.slug !== 'inchill') throw new BusinessRuleError('This endpoint is available only for the Inchill provider.', 'INCHILL_PROVIDER_REQUIRED'); return provider; }
    async _connection(providerId, includePending = false) { const query = this.Connection.findOne({ provider: providerId, isPrimary: true }); return includePending ? query.select('+agentPhone +pendingLogin.phone +pendingLogin.countryCode +pendingLogin.deviceId +pendingLogin.country +pendingLogin.language +pendingLogin.expiresAt') : query.select('+agentPhone'); }
    async _connectionOrThrow(providerId) { const connection = await this._connection(providerId); if (!connection?.agentPhone || !connection.enabled) throw new BusinessRuleError('No enabled Inchill connection is available.', 'INCHILL_CONNECTION_REQUIRED'); return connection; }
    _safe(error, operation) { if (error instanceof AppError) return error; if (error instanceof InchillClientError) return new AppError(`Inchill ${operation} is unavailable.`, error.code === 'INCHILL_TIMEOUT' ? 504 : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503, error.code); return new AppError(`Inchill ${operation} is unavailable.`, 502, 'INCHILL_PROVIDER_UNAVAILABLE'); }
    async _findOrCreate(providerId) { let connection = await this._connection(providerId, true); if (connection) return connection; try { return await this.Connection.create({ provider: providerId, isPrimary: true, enabled: true }); } catch (error) { if (error.code !== 11000) throw error; return this._connection(providerId, true); } }
    async sendOtp(providerId, input = {}) { await this._provider(providerId); const request = { phone: phone(input.phone), countryCode: countryCode(input.countryCode), deviceId: deviceId(input.deviceId), country: input.country ? String(input.country).trim().toUpperCase() : null, language: input.language ? String(input.language).trim() : null }; if (request.country && !/^[A-Z]{2}$/.test(request.country)) throw new ValidationError('country must be a two-letter uppercase country code.'); try { await this.client.sendOtp(request); } catch (error) { throw this._safe(error, 'OTP request'); }
        const connection = await this._findOrCreate(providerId); connection.pendingLogin = { ...request, expiresAt: new Date(this.now().getTime() + OTP_TTL_MS) }; if (!connection.agentPhone) connection.connectionStatus = INCHILL_CONNECTION_STATUS.OTP_PENDING; await connection.save(); return { connection: serialize(connection) }; }
    async verifyOtp(providerId, input = {}) { await this._provider(providerId); const otp = String(input.otp ?? '').trim(); if (!/^\d{4,8}$/.test(otp)) throw new ValidationError('otp must be 4 to 8 digits.'); const connection = await this._connection(providerId, true); const pending = connection?.pendingLogin; if (!pending || !pending.expiresAt || pending.expiresAt <= this.now()) throw new BusinessRuleError('No active Inchill OTP request exists.', 'INCHILL_OTP_EXPIRED'); try { await this.client.verifyOtp({ phone: pending.phone, otp, deviceId: pending.deviceId, country: pending.country, language: pending.language }); } catch (error) { throw this._safe(error, 'OTP verification'); }
        connection.agentPhone = pending.phone; connection.countryCode = pending.countryCode; connection.country = pending.country; connection.language = pending.language; connection.connectionStatus = INCHILL_CONNECTION_STATUS.CONNECTED; connection.lastSuccessfulAt = this.now(); connection.pendingLogin = undefined; await connection.save(); return { connection: serialize(connection) }; }
    async getConnection(providerId) { await this._provider(providerId); const connection = await this._connection(providerId, true); if (connection?.pendingLogin?.expiresAt <= this.now()) { connection.pendingLogin = undefined; if (!connection.agentPhone) connection.connectionStatus = INCHILL_CONNECTION_STATUS.UNKNOWN; await connection.save(); } return { connection: serialize(connection) }; }
    async validateSession(providerId) {
        await this._provider(providerId);
        // Include pendingLogin so an authoritative validation can clear stale
        // OTP state before the serialized result is returned.
        const connection = await this._connection(providerId, true);
        if (!connection?.agentPhone || !connection.enabled) {
            throw new BusinessRuleError('No enabled Inchill connection is available.', 'INCHILL_CONNECTION_REQUIRED');
        }

        let result;
        try {
            result = await this.client.validateSession(connection.agentPhone);
        } catch (error) {
            // A transport failure is not evidence that the account is
            // disconnected. Persist only the conservative UNKNOWN result.
            connection.connectionStatus = INCHILL_CONNECTION_STATUS.UNKNOWN;
            connection.lastValidationStatus = 'UNKNOWN';
            connection.lastValidatedAt = this.now();
            await connection.save();
            throw this._safe(error, 'session validation');
        }

        const upstreamStatus = String(result.data?.session?.status ?? 'UNKNOWN').toUpperCase();
        const validatedAt = this.now();
        const isValid = ['VALID', 'CONNECTED'].includes(upstreamStatus);
        const requiresReauth = ['REJECTED', 'REAUTH_REQUIRED'].includes(upstreamStatus);

        connection.lastValidatedAt = validatedAt;
        if (isValid) {
            connection.lastValidationStatus = 'VALID';
            connection.connectionStatus = INCHILL_CONNECTION_STATUS.CONNECTED;
            connection.lastSuccessfulAt = validatedAt;
            connection.pendingLogin = undefined;
        } else if (requiresReauth) {
            connection.lastValidationStatus = 'REJECTED';
            connection.connectionStatus = INCHILL_CONNECTION_STATUS.REAUTH_REQUIRED;
            connection.pendingLogin = undefined;
        } else {
            connection.lastValidationStatus = 'UNKNOWN';
            connection.connectionStatus = INCHILL_CONNECTION_STATUS.UNKNOWN;
        }

        await connection.save();
        return { connection: serialize(connection), session: { status: connection.lastValidationStatus } };
    }
    async getAgentProfile(providerId) { await this._provider(providerId); const connection = await this._connectionOrThrow(providerId); try { return { profile: normalizeIdentity((await this.client.getAgentProfile(connection.agentPhone)).data) }; } catch (error) { throw this._safe(error, 'profile lookup'); } }
    async getWalletBalance(providerId) { await this._provider(providerId); const connection = await this._connectionOrThrow(providerId); try { return { wallet: normalizeWallet((await this.client.getWalletBalance(connection.agentPhone)).data) }; } catch (error) { throw this._safe(error, 'wallet lookup'); } }
    async verifyTarget(providerId, { targetId } = {}) { await this._provider(providerId); const normalized = String(targetId ?? '').trim(); if (!normalized) throw new ValidationError('targetId is required.'); const connection = await this._connectionOrThrow(providerId); try { const result = await this.client.verifyTarget(connection.agentPhone, normalized); const identity = normalizeIdentity(result.data, normalized); if (!identity.vid && !identity.nickName) throw new BusinessRuleError('The Inchill ID is invalid or unavailable.', 'INCHILL_TARGET_INVALID'); return { verification: identity }; } catch (error) { if (error instanceof AppError) throw error; if (error instanceof InchillClientError && ['INCHILL_TARGET_INVALID'].includes(error.code)) throw new BusinessRuleError('The Inchill ID is invalid or unavailable.', 'INCHILL_TARGET_INVALID'); throw this._safe(error, 'target verification'); } }
    async getReadiness(providerId) { await this._provider(providerId); const connection = await this._connectionOrThrow(providerId); try { return { readiness: (await this.client.getTransferReadiness(connection.agentPhone)).data?.readiness ?? { session: 'UNKNOWN' } }; } catch (error) { throw this._safe(error, 'readiness lookup'); } }
}
const inchillConnectionService = new InchillConnectionService();
module.exports = { InchillConnectionService, inchillConnectionService, serializeInchillConnection: serialize, normalizeInchillIdentity: normalizeIdentity, normalizeInchillWallet: normalizeWallet };
