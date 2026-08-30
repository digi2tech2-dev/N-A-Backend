'use strict';

const fs = require('fs');

const { Provider } = require('../modules/providers/provider.model');
const {
    HagoProviderConnection,
    CONNECTION_STATUS,
    VALIDATION_STATUS,
} = require('../modules/providers/hago/hagoProviderConnection.model');
const { HagoConnectionService } = require('../modules/providers/hago/hagoConnection.service');
const { HagoClientError } = require('../modules/providers/hago/hago.client');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const makeClient = () => ({
    createLoginChallenge: jest.fn(),
    verifyLoginChallenge: jest.fn(),
    sessionValidation: jest.fn(),
    readiness: jest.fn(),
    agentProfile: jest.fn(),
    walletBalance: jest.fn(),
    verifyTarget: jest.fn(),
});

const makeProvider = (overrides = {}) => Provider.create({
    name: `Hago ${Date.now()} ${Math.random().toString(36).slice(2)}`,
    slug: 'hago',
    baseUrl: 'https://provider-record.example.invalid',
    syncInterval: 0,
    ...overrides,
});

const internalConnection = (providerId) => HagoProviderConnection.findOne({ provider: providerId, isPrimary: true })
    .select('+connectionId +pendingChallenge');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
});

describe('HagoProviderConnection model and service', () => {
    it('is provider-owned, supports one primary per provider, and protects internal fields by default', async () => {
        const provider = await makeProvider();
        const connection = await HagoProviderConnection.create({
            provider: provider._id,
            connectionId: 'con_existing',
            isPrimary: true,
            connectionStatus: CONNECTION_STATUS.CONNECTED,
            pendingChallenge: {
                challengeId: 'chl_internal',
                deviceId: 'device-internal',
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const ordinaryQuery = await HagoProviderConnection.findById(connection._id).lean();
        expect(ordinaryQuery).not.toHaveProperty('connectionId');
        expect(ordinaryQuery).not.toHaveProperty('pendingChallenge');
        expect(HagoProviderConnection.schema.indexes()).toEqual(expect.arrayContaining([
            [expect.objectContaining({ provider: 1, isPrimary: 1 }), expect.objectContaining({ unique: true })],
            [expect.objectContaining({ connectionId: 1 }), expect.objectContaining({ unique: true, sparse: true })],
        ]));
    });

    it('accepts only existing, non-deleted Hago providers', async () => {
        const client = makeClient();
        const service = new HagoConnectionService({ client });
        const hago = await makeProvider();
        const other = await makeProvider({ name: `Other ${Date.now()}`, slug: 'toros' });
        const deleted = await makeProvider({ name: `Deleted ${Date.now()}`, slug: 'hago-deleted', deletedAt: new Date() });

        await expect(service.getHagoProvider(hago._id)).resolves.toMatchObject({ _id: hago._id });
        await expect(service.getHagoProvider(other._id)).rejects.toMatchObject({ code: 'HAGO_PROVIDER_REQUIRED' });
        await expect(service.getHagoProvider(deleted._id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('serializes only connection presence for disconnected and connected records', async () => {
        const provider = await makeProvider();
        const service = new HagoConnectionService({ client: makeClient() });
        await HagoProviderConnection.create({
            provider: provider._id,
            isPrimary: true,
            connectionStatus: CONNECTION_STATUS.UNKNOWN,
        });

        await expect(service.getConnection(provider._id)).resolves.toMatchObject({
            connection: { hasConnection: false, connectionStatus: CONNECTION_STATUS.UNKNOWN },
        });

        const stored = await internalConnection(provider._id);
        stored.connectionId = 'con_opaque_internal';
        stored.pendingChallenge = {
            challengeId: 'chl_internal',
            deviceId: 'device-internal',
            expiresAt: new Date(Date.now() + 60_000),
        };
        // UNKNOWN is intentionally valid for a real connection whose latest
        // session validation was inconclusive.
        await stored.save();

        const connected = await service.getConnection(provider._id);
        const serialized = JSON.stringify(connected);

        expect(connected.connection).toMatchObject({
            hasConnection: true,
            connectionStatus: CONNECTION_STATUS.UNKNOWN,
        });
        expect(serialized).not.toContain('con_opaque_internal');
        expect(serialized).not.toContain('chl_internal');
        expect(serialized).not.toContain('device-internal');
    });

    it('persists a safe pending login challenge without persisting an OTP or exposing internal identifiers', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockResolvedValue({
            status: 'OTP_SENT',
            challengeId: 'chl_internal_only',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
        const service = new HagoConnectionService({ client });

        const result = await service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678', country: 'EG', language: 'ar',
        });
        const stored = await internalConnection(provider._id);
        const serialized = JSON.stringify(result);

        expect(client.createLoginChallenge).toHaveBeenCalledWith({
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678', country: 'EG', language: 'ar',
        });
        expect(stored.connectionId).toBeUndefined();
        expect(stored.pendingChallenge).toMatchObject({
            challengeId: 'chl_internal_only', deviceId: 'device-12345678', maskedIdentity: '••••7890',
        });
        expect(stored.toObject()).not.toHaveProperty('otp');
        expect(result.connection).toMatchObject({
            connectionStatus: CONNECTION_STATUS.OTP_PENDING,
            pendingLogin: { status: CONNECTION_STATUS.OTP_PENDING },
        });
        expect(serialized).not.toContain('chl_internal_only');
        expect(serialized).not.toContain('device-12345678');
        expect(serialized).not.toContain('+201234567890');
    });

    it('clears expired pending state from the public connection response without removing a usable reconnect connection', async () => {
        const provider = await makeProvider();
        const service = new HagoConnectionService({ client: makeClient() });
        await HagoProviderConnection.create({
            provider: provider._id,
            connectionId: 'con_existing',
            isPrimary: true,
            enabled: true,
            connectionStatus: CONNECTION_STATUS.CONNECTED,
            pendingChallenge: {
                challengeId: 'chl_expired',
                deviceId: 'device-internal',
                expiresAt: new Date(Date.now() - 1_000),
            },
        });

        const result = await service.getConnection(provider._id);
        const stored = await internalConnection(provider._id);
        const serialized = JSON.stringify(result);

        expect(result.connection).toMatchObject({ hasConnection: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
        expect(result.connection).not.toHaveProperty('pendingLogin');
        expect(stored.connectionId).toBe('con_existing');
        expect(stored.pendingChallenge).toBeUndefined();
        expect(serialized).not.toContain('con_existing');
        expect(serialized).not.toContain('chl_expired');
        expect(serialized).not.toContain('device-internal');
    });

    it('replaces an expired pending challenge with a new valid challenge', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockResolvedValue({
            status: 'OTP_SENT', challengeId: 'chl_replacement', expiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
        await HagoProviderConnection.create({
            provider: provider._id,
            isPrimary: true,
            connectionStatus: CONNECTION_STATUS.OTP_PENDING,
            pendingChallenge: {
                challengeId: 'chl_expired',
                deviceId: 'device-expired',
                expiresAt: new Date(Date.now() - 1_000),
            },
        });
        const service = new HagoConnectionService({ client });

        const result = await service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        });
        const stored = await internalConnection(provider._id);

        expect(client.createLoginChallenge).toHaveBeenCalledTimes(1);
        expect(stored.pendingChallenge).toMatchObject({ challengeId: 'chl_replacement', deviceId: 'device-12345678' });
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.OTP_PENDING);
        expect(result.connection).toMatchObject({ pendingLogin: { status: CONNECTION_STATUS.OTP_PENDING } });
        expect(JSON.stringify(result)).not.toContain('chl_replacement');
    });

    it('leaves a first connection UNKNOWN when upstream login challenge creation fails', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockRejectedValue(new HagoClientError('upstream 401 detail', { code: 'HAGO_REQUEST_FAILED', statusCode: 401 }));
        const service = new HagoConnectionService({ client });

        await expect(service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        })).rejects.toMatchObject({ code: 'HAGO_REQUEST_FAILED' });

        const stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBeUndefined();
        expect(stored.pendingChallenge).toBeUndefined();
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.UNKNOWN);
    });

    it.each([
        ['missing challengeId', { status: 'OTP_SENT', challengeId: '', expiresAt: new Date(Date.now() + 120_000).toISOString() }],
        ['invalid expiresAt', { status: 'OTP_SENT', challengeId: 'chl_invalid_expiry', expiresAt: 'not-a-date' }],
        ['expired expiresAt', { status: 'OTP_SENT', challengeId: 'chl_expired', expiresAt: new Date(Date.now() - 1_000).toISOString() }],
    ])('leaves a disconnected connection UNKNOWN when Hago returns an invalid login challenge: %s', async (_reason, upstreamResponse) => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockResolvedValue(upstreamResponse);
        const service = new HagoConnectionService({ client });

        await expect(service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        })).rejects.toMatchObject({ code: 'HAGO_INVALID_CHALLENGE_RESPONSE' });

        const stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBeUndefined();
        expect(stored.pendingChallenge).toBeUndefined();
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.UNKNOWN);
    });

    it('normalizes legacy disconnected OTP_PENDING state before a new challenge attempt', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockRejectedValue(new HagoClientError('upstream 401 detail', { code: 'HAGO_REQUEST_FAILED', statusCode: 401 }));
        await HagoProviderConnection.create({
            provider: provider._id,
            isPrimary: true,
            enabled: true,
            connectionStatus: CONNECTION_STATUS.OTP_PENDING,
        });
        const service = new HagoConnectionService({ client });

        await expect(service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        })).rejects.toMatchObject({ code: 'HAGO_REQUEST_FAILED' });

        const stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBeUndefined();
        expect(stored.pendingChallenge).toBeUndefined();
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.UNKNOWN);
    });

    it('preserves an existing usable connection when a reconnect challenge request fails', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockRejectedValue(new HagoClientError('upstream 401 detail', { code: 'HAGO_REQUEST_FAILED', statusCode: 401 }));
        await HagoProviderConnection.create({
            provider: provider._id,
            connectionId: 'con_existing',
            isPrimary: true,
            enabled: true,
            connectionStatus: CONNECTION_STATUS.CONNECTED,
        });
        const service = new HagoConnectionService({ client });

        await expect(service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        })).rejects.toMatchObject({ code: 'HAGO_REQUEST_FAILED' });

        const stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBe('con_existing');
        expect(stored.pendingChallenge).toBeUndefined();
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.CONNECTED);
    });

    it('keeps an existing connection while a reconnect is pending and updates it only after a successful OTP verification', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        client.createLoginChallenge.mockResolvedValue({
            status: 'OTP_SENT', challengeId: 'chl_reconnect', expiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
        client.verifyLoginChallenge.mockResolvedValue({
            status: 'SUCCESS', connection: { connectionId: 'con_replaced', status: 'CONNECTED' },
        });
        await HagoProviderConnection.create({
            provider: provider._id, connectionId: 'con_existing', isPrimary: true, enabled: true,
            connectionStatus: CONNECTION_STATUS.CONNECTED,
        });
        const service = new HagoConnectionService({ client });

        await service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678',
        });
        const pending = await internalConnection(provider._id);
        expect(pending.connectionId).toBe('con_existing');
        expect(pending.connectionStatus).toBe(CONNECTION_STATUS.CONNECTED);

        const result = await service.verifyLoginChallenge(provider._id, { otp: '123456' });
        const updated = await internalConnection(provider._id);
        expect(client.verifyLoginChallenge).toHaveBeenCalledWith('chl_reconnect', { otp: '123456', deviceId: 'device-12345678' });
        expect(updated.connectionId).toBe('con_replaced');
        expect(updated.pendingChallenge).toBeUndefined();
        expect(updated.connectionStatus).toBe(CONNECTION_STATUS.CONNECTED);
        expect(JSON.stringify(result)).not.toContain('con_replaced');
        expect(updated.toObject()).not.toHaveProperty('otp');
    });

    it('preserves an older valid connection when OTP verification fails or the challenge expires', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        const service = new HagoConnectionService({ client });
        await HagoProviderConnection.create({
            provider: provider._id, connectionId: 'con_existing', isPrimary: true, enabled: true,
            connectionStatus: CONNECTION_STATUS.CONNECTED,
            pendingChallenge: {
                challengeId: 'chl_retryable', deviceId: 'device-12345678', expiresAt: new Date(Date.now() + 120_000),
            },
        });
        client.verifyLoginChallenge.mockRejectedValue(new HagoClientError('upstream detail must not leak', { code: 'HAGO_REQUEST_FAILED' }));

        await expect(service.verifyLoginChallenge(provider._id, { otp: 'bad-otp' })).rejects.toMatchObject({ code: 'HAGO_REQUEST_FAILED' });
        let stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBe('con_existing');
        expect(stored.pendingChallenge.challengeId).toBe('chl_retryable');

        stored.pendingChallenge.expiresAt = new Date(Date.now() - 1_000);
        await stored.save();
        await expect(service.verifyLoginChallenge(provider._id, { otp: '123456' })).rejects.toMatchObject({ code: 'HAGO_LOGIN_CHALLENGE_EXPIRED' });
        stored = await internalConnection(provider._id);
        expect(stored.connectionId).toBe('con_existing');
        expect(stored.pendingChallenge).toBeUndefined();
        expect(client.verifyLoginChallenge).toHaveBeenCalledTimes(1);
    });

    it('resolves the primary connection only within its provider and normalizes session status safely', async () => {
        const provider = await makeProvider();
        const other = await makeProvider({ name: `Other provider ${Date.now()}`, slug: 'toros' });
        const client = makeClient();
        client.sessionValidation.mockResolvedValue({ status: 'SUCCESS', session: { status: 'REJECTED', token: 'never-return' } });
        await HagoProviderConnection.create({ provider: provider._id, connectionId: 'con_provider', isPrimary: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
        await HagoProviderConnection.create({ provider: other._id, connectionId: 'con_other', isPrimary: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
        const service = new HagoConnectionService({ client });

        const result = await service.validateSession(provider._id);
        const stored = await internalConnection(provider._id);
        expect(client.sessionValidation).toHaveBeenCalledWith('con_provider');
        expect(result.session).toEqual({ upstreamStatus: VALIDATION_STATUS.REJECTED, connectionStatus: CONNECTION_STATUS.REAUTH_REQUIRED });
        expect(stored.lastValidationStatus).toBe(VALIDATION_STATUS.REJECTED);
        expect(stored.connectionStatus).toBe(CONNECTION_STATUS.REAUTH_REQUIRED);
        expect(JSON.stringify(result)).not.toContain('con_provider');
        expect(JSON.stringify(result)).not.toContain('never-return');
    });

    it('returns allowlisted, read-only readiness, profile, wallet, and target diagnostics', async () => {
        const provider = await makeProvider();
        const client = makeClient();
        await HagoProviderConnection.create({ provider: provider._id, connectionId: 'con_diagnostics', isPrimary: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
        client.readiness.mockResolvedValue({ status: 'READY', headers: { authorization: 'never-return' } });
        client.agentProfile.mockResolvedValue({ data: { uid: 'agent-uid', nickname: 'Agent', avatar: 'safe.png', token: 'nope' } });
        client.walletBalance.mockResolvedValue({ wallet: { balances: { hagoDiamond: 4, hagoDiamondNew: 3, hagoCrystal: 2, cookie: 'nope' } } });
        client.verifyTarget.mockResolvedValue({ target: { uid: 'target-uid', nickName: 'Target', avatar: 'target.png', secret: 'nope' } });
        const service = new HagoConnectionService({ client });

        await expect(service.getReadiness(provider._id)).resolves.toEqual({ readiness: { status: 'READY' } });
        await expect(service.getAgentProfile(provider._id)).resolves.toEqual({ profile: { uid: 'agent-uid', nickName: 'Agent', avatar: 'safe.png' } });
        await expect(service.getWalletBalance(provider._id)).resolves.toEqual({ wallet: { hagoDiamond: 4, hagoDiamondNew: 3, hagoCrystal: 2 } });
        await expect(service.verifyTarget(provider._id, { targetId: 'vid-123' })).resolves.toEqual({
            verification: { targetId: 'vid-123', uid: 'target-uid', nickName: 'Target', avatar: 'target.png' },
        });
        expect(client.agentProfile).toHaveBeenCalledWith('con_diagnostics');
        expect(client.walletBalance).toHaveBeenCalledWith('con_diagnostics');
        expect(client.verifyTarget).toHaveBeenCalledWith('con_diagnostics', 'vid-123');
    });

    it('rejects unsupported request fields and contains no financial mutation path', async () => {
        const provider = await makeProvider();
        const service = new HagoConnectionService({ client: makeClient() });
        await expect(service.createLoginChallenge(provider._id, {
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678', otp: 'never-accepted',
        })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(service.verifyTarget(provider._id, { targetId: 'vid-1', amount: 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

        const connectionSource = fs.readFileSync(require.resolve('../modules/providers/hago/hagoConnection.service'), 'utf8');
        const controllerSource = fs.readFileSync(require.resolve('../modules/providers/hago/hagoConnection.controller'), 'utf8');
        expect(`${connectionSource}\n${controllerSource}`).not.toMatch(/auto-recharge|placeOrder|orderFulfillment|wallet\.service/i);
    });
});
