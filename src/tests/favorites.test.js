'use strict';

process.env.SAFE_LOCAL_PRODUCTION_MODE = 'true';
process.env.BACKGROUND_JOBS_ENABLED = 'false';
process.env.WHATSAPP_AUTO_INIT = 'false';

const http = require('http');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User } = require('../modules/users/user.model');
const { Product } = require('../modules/products/product.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
} = require('./testHelpers');

let app;
let server;
let baseUrl;

const authHeaders = (user) => ({
    Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, config.jwt.secret, { expiresIn: '1h' })}`,
});

const request = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, {
        method,
        headers: {
            ...headers,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
    }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
            try {
                resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});

beforeAll(async () => {
    await connectTestDB();
    app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(clearCollections);

describe('customer product favorites', () => {
    const createFixture = async () => {
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id });
        const otherCustomer = await createCustomer({ groupId: group._id });
        const product = await createProduct({
            name: 'Favorite Product',
            executionType: 'manual',
            providerPrice: '3.50',
        });
        return { customer, otherCustomer, product };
    };

    test('rejects unauthenticated access', async () => {
        const response = await request('GET', '/api/users/me/favorites');
        expect(response.status).toBe(401);
    });

    test('adds favorites idempotently and persists them only for the authenticated user', async () => {
        const { customer, otherCustomer, product } = await createFixture();
        const path = `/api/users/me/favorites/${product._id}`;

        expect((await request('POST', path, { headers: authHeaders(customer) })).status).toBe(200);
        expect((await request('POST', path, { headers: authHeaders(customer) })).status).toBe(200);

        const stored = await User.findById(customer._id).select('favoriteProductIds');
        expect(stored.favoriteProductIds.map(String)).toEqual([String(product._id)]);

        const ownFavorites = await request('GET', '/api/users/me/favorites', { headers: authHeaders(customer) });
        expect(ownFavorites.status).toBe(200);
        expect(ownFavorites.body.data.products).toHaveLength(1);
        expect(String(ownFavorites.body.data.products[0]._id)).toBe(String(product._id));
        expect(ownFavorites.body.data.products[0].providerPrice).toBeUndefined();
        expect(ownFavorites.body.data.products[0].executionType).toBeUndefined();

        const otherFavorites = await request('GET', '/api/users/me/favorites', { headers: authHeaders(otherCustomer) });
        expect(otherFavorites.status).toBe(200);
        expect(otherFavorites.body.data.products).toEqual([]);
    });

    test('removes favorites idempotently', async () => {
        const { customer, product } = await createFixture();
        const path = `/api/users/me/favorites/${product._id}`;
        await request('POST', path, { headers: authHeaders(customer) });

        expect((await request('DELETE', path, { headers: authHeaders(customer) })).status).toBe(200);
        expect((await request('DELETE', path, { headers: authHeaders(customer) })).status).toBe(200);

        const stored = await User.findById(customer._id).select('favoriteProductIds');
        expect(stored.favoriteProductIds).toEqual([]);
    });

    test('rejects invalid or nonexistent products when adding', async () => {
        const { customer } = await createFixture();

        const invalid = await request('POST', '/api/users/me/favorites/not-an-object-id', { headers: authHeaders(customer) });
        expect(invalid.status).toBe(400);
        expect(invalid.body.code).toBe('INVALID_PRODUCT_ID');

        const missing = await request('POST', '/api/users/me/favorites/507f1f77bcf86cd799439011', { headers: authHeaders(customer) });
        expect(missing.status).toBe(404);
    });

    test('filters inactive and stale deleted references without failing GET', async () => {
        const { customer, product } = await createFixture();
        const inactive = await createProduct({ name: 'Inactive favorite', isActive: false });
        await User.updateOne(
            { _id: customer._id },
            { $addToSet: { favoriteProductIds: { $each: [product._id, inactive._id] } } }
        );
        await Product.updateOne({ _id: product._id }, { $set: { deletedAt: new Date(), isActive: false } });

        const response = await request('GET', '/api/users/me/favorites', { headers: authHeaders(customer) });
        expect(response.status).toBe(200);
        expect(response.body.data.products).toEqual([]);
    });
});
