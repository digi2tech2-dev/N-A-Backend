'use strict';

jest.mock('axios');

const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_MODES, PRICING_STRATEGIES } = require('../modules/products/product.model');
const { HagoClient, HagoClientError } = require('../modules/providers/hago/hago.client');
const { HagoAdapter, buildSyntheticProducts } = require('../modules/providers/adapters/hago.adapter');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const makeHttpClient = () => ({
    get: jest.fn(),
    post: jest.fn(),
});

const hagoProvider = {
    name: 'Hago',
    slug: 'hago',
    baseUrl: 'https://provider-record.example.invalid',
    apiToken: 'provider-token-must-not-be-used',
};

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    jest.clearAllMocks();
});

describe('Hago V2 client (read-only)', () => {
    it('uses the configured base URL and V2 x-client-api-key only', async () => {
        const httpClient = makeHttpClient();
        httpClient.post.mockResolvedValueOnce({ data: { status: 'SUCCESS', target: { uid: '123' } } });
        const client = new HagoClient({
            baseUrl: 'https://hago.example.test',
            apiKey: 'server-only-key',
            timeoutMs: 1234,
            httpClient,
        });

        await client.verifyTarget('con_test', 'vid_123');

        expect(client.baseUrl).toBe('https://hago.example.test');
        expect(client.timeout).toBe(1234);
        expect(httpClient.post).toHaveBeenCalledWith(
            '/api/v2/connections/con_test/verify-id',
            { targetId: 'vid_123' },
            { headers: { 'x-client-api-key': 'server-only-key' } }
        );
        expect(httpClient.post.mock.calls[0][2].headers).not.toHaveProperty('x-internal-api-key');
    });

    it('configures axios with the requested base URL and timeout', () => {
        const createdClient = makeHttpClient();
        axios.create.mockReturnValueOnce(createdClient);

        new HagoClient({
            baseUrl: 'https://configured-hago.example.test/',
            apiKey: 'server-only-key',
            timeoutMs: 4321,
        });

        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://configured-hago.example.test',
            timeout: 4321,
            headers: expect.not.objectContaining({ 'x-client-api-key': expect.anything() }),
        }));
    });

    it('normalizes a timeout without exposing the API key', async () => {
        const httpClient = makeHttpClient();
        const timeout = new Error('request failed for key server-only-key');
        timeout.code = 'ECONNABORTED';
        httpClient.post.mockRejectedValueOnce(timeout);
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });

        try {
            await client.walletBalance('con_test');
        } catch (error) {
            expect(error).toMatchObject({
                name: 'HagoClientError',
                code: 'HAGO_UPSTREAM_TIMEOUT',
                message: 'Hago wallet balance lookup timed out.',
            });
            expect(error.message).not.toContain('server-only-key');
            expect(error).not.toHaveProperty('config');
            expect(error).not.toHaveProperty('response');
        }
    });

    it('uses the documented V2 login challenge endpoints and never uses the legacy key header', async () => {
        const httpClient = makeHttpClient();
        httpClient.post
            .mockResolvedValueOnce({ data: { status: 'OTP_SENT', challengeId: 'chl_test', expiresAt: '2030-01-01T00:00:00.000Z' } })
            .mockResolvedValueOnce({ data: { status: 'SUCCESS', connection: { connectionId: 'con_test' } } });
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });

        await client.createLoginChallenge({
            phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678', country: 'EG', language: 'ar',
        });
        await client.verifyLoginChallenge('chl_test', { otp: '123456', deviceId: 'device-12345678' });

        expect(httpClient.post).toHaveBeenNthCalledWith(1,
            '/api/v2/login-challenges',
            { phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678', country: 'EG', language: 'ar' },
            { headers: { 'x-client-api-key': 'server-only-key' } }
        );
        expect(httpClient.post).toHaveBeenNthCalledWith(2,
            '/api/v2/login-challenges/chl_test/verify',
            { otp: '123456', deviceId: 'device-12345678' },
            { headers: { 'x-client-api-key': 'server-only-key' } }
        );
        for (const [, , config] of httpClient.post.mock.calls) {
            expect(config.headers).not.toHaveProperty('x-internal-api-key');
        }
    });

    it('implements documented V2 preview, readiness, history, transaction, and reconciliation reads', async () => {
        const httpClient = makeHttpClient();
        httpClient.post.mockResolvedValue({ data: { status: 'SUCCESS' } });
        const client = new HagoClient({ apiKey: 'server-only-key', httpClient });

        await client.sessionValidation('con_test');
        await client.agentProfile('con_test');
        await client.accountHistory('con_test', { page: 1 });
        await client.transferReadiness('con_test');
        await client.nobilityReadiness('con_test', 'vid_1');
        await client.nobilityPurchaseReadiness('con_test', 'vid_1', 2);
        await client.diamondPreview('con_test', 10);
        await client.crystalPreview('con_test', 10);
        await client.nobilityPreview('con_test', 'vid_1', 2);
        await client.listTransactions('con_test');
        await client.reconcileTransaction('con_test', 'txn_1');

        const paths = httpClient.post.mock.calls.map(([path]) => path);
        expect(paths).toEqual(expect.arrayContaining([
            '/api/v2/connections/con_test/session/validate',
            '/api/v2/connections/con_test/account-history',
            '/api/v2/connections/con_test/previews/diamond',
            '/api/v2/connections/con_test/previews/crystal',
            '/api/v2/connections/con_test/previews/nobility',
            '/api/v2/connections/con_test/transactions',
            '/api/v2/connections/con_test/transactions/reconcile',
        ]));
        expect(paths.some((path) => path.includes('/auto-recharge/'))).toBe(false);
    });
});

describe('Hago adapter', () => {
    it('is resolved by adapter factory for the hago slug without using Provider tokens', () => {
        const adapter = getProviderAdapter(hagoProvider, { strict: true });

        expect(adapter).toBeInstanceOf(HagoAdapter);
        expect(adapter.client.apiKey).not.toBe(hagoProvider.apiToken);
        expect(HagoAdapter.supportedFeatures).toEqual(expect.arrayContaining([
            'fetchProducts', 'getBalance', 'getAccount', 'validateUser', 'sessionValidation', 'previews', 'reconciliation',
        ]));
        expect(HagoAdapter.supportedFeatures).not.toContain('placeOrder');
    });

    it('generates the six deterministic non-priced synthetic products', async () => {
        const products = buildSyntheticProducts();
        const adapter = new HagoAdapter(hagoProvider, { client: {} });

        expect(await adapter.getProducts()).toEqual(products);
        expect(products).toHaveLength(6);
        expect(products.map((product) => product.externalProductId)).toEqual([
            'HAGO_DIAMOND_AMOUNT',
            'HAGO_CRYSTAL_AMOUNT',
            'HAGO_NOBILITY_1',
            'HAGO_NOBILITY_2',
            'HAGO_NOBILITY_3',
            'HAGO_NOBILITY_4',
        ]);
        expect(products.slice(0, 2)).toEqual(expect.arrayContaining([
            expect.objectContaining({ rawPrice: '0', minQty: 1, maxQty: null }),
        ]));
        expect(products.slice(2).every((product) => product.minQty === 1 && product.maxQty === 1)).toBe(true);
        expect(products.slice(2).map((product) => product.rawName)).toEqual([
            'Hago Knight', 'Hago Viscount', 'Hago Earl', 'Hago Duke',
        ]);
        expect(products.every((product) => product.rawPayload.pricing === 'manual_n_and_a_configuration_required')).toBe(true);
    });

    it('syncs synthetic records idempotently without inventing a maximum or price', async () => {
        const provider = await Provider.create({
            name: 'Hago',
            slug: 'hago',
            baseUrl: 'https://provider-record.example.invalid',
            isActive: true,
            syncInterval: 0,
        });

        const first = await syncProviderProducts(provider._id);
        const second = await syncProviderProducts(provider._id);
        const products = await ProviderProduct.find({ provider: provider._id }).sort({ externalProductId: 1 }).lean();
        const diamond = products.find((product) => product.externalProductId === 'HAGO_DIAMOND_AMOUNT');

        expect(first.totalFetched).toBe(6);
        expect(second.totalFetched).toBe(6);
        expect(products).toHaveLength(6);
        expect(diamond).toMatchObject({ rawPrice: '0', minQty: 1, maxQty: null });
        expect(products.filter((product) => product.externalProductId === 'HAGO_DIAMOND_AMOUNT')).toHaveLength(1);
    });

    it('never propagates the Hago Nobility zero-price sentinel into configured product pricing', async () => {
        const hago = await Provider.create({
            name: 'Hago Price Guard', slug: 'hago', baseUrl: 'https://provider.invalid', isActive: true, syncInterval: 0,
        });
        await syncProviderProducts(hago._id);
        const pp = await ProviderProduct.findOne({ provider: hago._id, externalProductId: 'HAGO_NOBILITY_1' });
        const product = await Product.create({
            name: 'Configured Hago Knight', basePrice: '100', minQty: 1, maxQty: 1,
            provider: hago._id, providerProduct: pp._id,
            pricingMode: PRICING_MODES.MANUAL,
            pricingStrategy: PRICING_STRATEGIES.HAGO_NOBILITY_READINESS,
            hagoNobilityPricing: { purchaseBasePrice: '100', renewalBasePrice: '50' },
        });

        await syncProviderProducts(hago._id);
        const refreshed = await Product.findById(product._id);
        expect(refreshed.basePrice).toBe('100');
        expect(refreshed.providerPrice).toBeNull();
    });

    it('maps validateUser to V2 target verification and returns only normalized safe fields', async () => {
        const client = {
            verifyTarget: jest.fn().mockResolvedValue({
                status: 'SUCCESS',
                target: {
                    uid: 'uid_123',
                    nickName: 'Hago User',
                    avatar: 'https://avatar.example.test/u.png',
                    token: 'must-not-leak',
                },
            }),
        };
        const adapter = new HagoAdapter(hagoProvider, { client });

        await expect(adapter.validateUser('vid_123', { connectionId: 'con_test' })).resolves.toEqual({
            targetId: 'vid_123',
            uid: 'uid_123',
            nickName: 'Hago User',
            avatar: 'https://avatar.example.test/u.png',
        });
        expect(client.verifyTarget).toHaveBeenCalledWith('con_test', 'vid_123');
    });

    it('maps the V2 wallet response safely', async () => {
        const client = {
            walletBalance: jest.fn().mockResolvedValue({
                status: 'SUCCESS',
                wallet: { balances: { hagoDiamond: 10, hagoCrystal: 5, token: 'must-not-leak' } },
            }),
        };
        const adapter = new HagoAdapter(hagoProvider, { client });

        const result = await adapter.getBalance('con_test');

        expect(client.walletBalance).toHaveBeenCalledWith('con_test');
        expect(result).toEqual({
            balance: { hagoDiamond: 10, hagoCrystal: 5 },
            wallet: { hagoDiamond: 10, hagoCrystal: 5 },
            rawResponse: { status: 'SUCCESS', wallet: { balances: { hagoDiamond: 10, hagoCrystal: 5 } } },
        });
    });

    it('fails closed for placeOrder without making an HTTP request', async () => {
        const client = { post: jest.fn(), walletBalance: jest.fn() };
        const adapter = new HagoAdapter(hagoProvider, { client });

        await expect(adapter.placeOrder({ targetId: 'vid_123', amount: 1 })).resolves.toMatchObject({
            success: false,
            errorCode: 'HAGO_MUTATIONS_DISABLED',
            providerStatus: 'Cancelled',
        });
        expect(client.post).not.toHaveBeenCalled();
        expect(client.walletBalance).not.toHaveBeenCalled();
    });

    it('requires an explicit connection ID for connection-owned reads', async () => {
        const adapter = new HagoAdapter(hagoProvider, { client: new HagoClient({ apiKey: 'server-only-key', httpClient: makeHttpClient() }) });
        await expect(adapter.getBalance()).rejects.toMatchObject({
            code: 'HAGO_CONNECTION_ID_REQUIRED',
        });
    });
});
