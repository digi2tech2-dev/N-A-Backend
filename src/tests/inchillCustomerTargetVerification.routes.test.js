'use strict';

const http = require('http');
const jwt = require('jsonwebtoken');

const mockVerificationService = { verifyTarget: jest.fn() };
jest.mock('../modules/providers/inchill/inchillCustomerTargetVerification.service', () => ({
    inchillCustomerTargetVerificationService: mockVerificationService,
}));

const config = require('../config/config');
const { Product } = require('../modules/products/product.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup } = require('./testHelpers');
const app = require('../app');

let server;
let baseUrl;

const requestJson = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(path, baseUrl), {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
    }, (res) => {
        let response = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { response += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: response ? JSON.parse(response) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});

const tokenFor = (user) => jwt.sign({ id: user._id.toString() }, config.jwt.secret, { expiresIn: '5m' });

beforeAll(async () => {
    await connectTestDB();
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await disconnectTestDB();
});
beforeEach(async () => { await clearCollections(); jest.clearAllMocks(); });

describe('customer Inchill target verification route', () => {
    it('rejects unauthenticated requests before product verification', async () => {
        const response = await requestJson('POST', '/api/products/64a000000000000000000001/inchill/verify-target', { body: { targetId: '51511' } });
        expect(response.status).toBe(401);
        expect(mockVerificationService.verifyTarget).not.toHaveBeenCalled();
    });

    it('uses the server-loaded product and returns only the safe verification DTO', async () => {
        const { customer } = await createCustomerWithGroup();
        const product = await Product.create({ name: `Inchill ${Date.now()}`, basePrice: '1', minQty: 1, maxQty: 1, pricingMode: 'manual' });
        mockVerificationService.verifyTarget.mockResolvedValue({ verified: true, targetId: '51511', displayName: 'Safe player', vid: '51511', country: 'EG' });

        const response = await requestJson('POST', `/api/products/${product._id}/inchill/verify-target`, {
            token: tokenFor(customer), body: { targetId: '51511' },
        });

        expect(response.status).toBe(200);
        expect(mockVerificationService.verifyTarget).toHaveBeenCalledWith(expect.objectContaining({
            product: expect.objectContaining({ _id: product._id }), targetId: '51511',
        }));
        expect(response.body.data).toEqual({ verified: true, targetId: '51511', displayName: 'Safe player', vid: '51511', country: 'EG' });
        expect(JSON.stringify(response.body)).not.toMatch(/agentPhone|connection|token|session|raw|secret/i);
    });

    it('marks the published Inchill adapter relation for the customer runtime shape', async () => {
        const { customer } = await createCustomerWithGroup();
        const provider = await Provider.create({ name: `Inchill ${Date.now()}`, slug: 'inchill', baseUrl: 'https://inchill.invalid', syncInterval: 0 });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'INCHILL_DIAMOND_AMOUNT',
            rawName: 'Inchill Diamond',
            rawPrice: '0',
            minQty: 1,
            maxQty: 999999999,
            rawPayload: { metadata: { serviceType: 'DIAMOND', source: 'inchill-v1' } },
        });
        const product = await Product.create({
            name: `Inchill Diamond ${Date.now()}`,
            basePrice: '1',
            minQty: 1,
            maxQty: 10,
            provider: provider._id,
            providerProduct: providerProduct._id,
            pricingMode: 'manual',
            executionType: 'automatic',
        });

        const response = await requestJson('GET', '/api/products', { token: tokenFor(customer) });
        const listed = response.body.data.find((item) => String(item._id) === String(product._id));

        expect(response.status).toBe(200);
        expect(listed).toMatchObject({
            isInchillDiamond: true,
            requiresInchillTargetVerification: true,
        });
        expect(listed).not.toHaveProperty('provider');
        expect(listed).not.toHaveProperty('providerProduct');
    });
});
