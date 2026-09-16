'use strict';

// This suite deliberately uses app.js (never server.js) and a real loopback
// socket.  SAFE_LOCAL prevents all import/startup side effects.
process.env.SAFE_LOCAL_PRODUCTION_MODE = 'true';
process.env.BACKGROUND_JOBS_ENABLED = 'false';
process.env.WHATSAPP_AUTO_INIT = 'false';

const http = require('http');
const {
    connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createProduct, freshUser,
} = require('./testHelpers');
const { Category } = require('../modules/categories/category.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Order, ORDER_STATUS, MAX_RETRY_COUNT } = require('../modules/orders/order.model');
const orderService = require('../modules/orders/order.service');
const { executeOrder, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const { syncProviderProducts } = require('../modules/providers/providerCatalog.service');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const axios = require('axios');

let app;
let server;
let upstreamBase;

const rawGet = (path, token) => new Promise((resolve, reject) => {
    const req = http.request(new URL(path, `${upstreamBase}/`), { headers: { 'api-token': token } }, (res) => {
        let data = ''; res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end();
});

beforeAll(async () => {
    await connectTestDB();
    app = require('../app');
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    upstreamBase = `http://127.0.0.1:${server.address().port}/client/api`;
});
afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});
beforeEach(async () => clearCollections());

test('real localhost catalog sync and canonical placement preserve the downstream order reference', async () => {
    const rawToken = 'local-canonical-upstream-token';
    const { customer: upstreamReseller } = await createCustomerWithGroup({
        apiToken: rawToken, isApiEnabled: true, walletBalance: 100, currency: 'USD',
    }, { percentage: 0 });
    const category = await Category.create({ name: 'Local Canonical Category' });
    const upstreamProduct = await createProduct({
        name: 'Local Canonical Product', category: String(category._id), basePrice: 10, minQty: 1, maxQty: 1,
        executionType: 'manual', orderFields: [{ id: 'player', key: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }],
    });

    const provider = await Provider.create({
        name: 'Local Canonical Provider', slug: 'local-canonical-provider', adapterType: 'canonical-b2b',
        baseUrl: upstreamBase, apiToken: rawToken, isActive: true,
    });
    const adapter = new CanonicalB2BAdapter(provider);
    expect((await adapter.getBalance()).balance).toBe('100');
    expect((await adapter.getProducts()).some((item) => item.externalProductId === String(upstreamProduct.compatProductId))).toBe(true);

    await syncProviderProducts(provider._id);
    const providerProduct = await ProviderProduct.findOne({ provider: provider._id, externalProductId: String(upstreamProduct.compatProductId) });
    expect(providerProduct).toBeTruthy();
    expect(providerProduct.rawPayload.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'player_id' })]));

    const { customer: downstreamUser } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' }, { percentage: 0 });
    const downstreamProduct = await createProduct({
        name: 'Downstream local product', basePrice: 10, executionType: 'manual', provider: provider._id,
        providerProduct: providerProduct._id, orderFields: [{ id: 'player', key: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }],
    });
    const created = await orderService.createOrder({
        userId: downstreamUser._id, productId: downstreamProduct._id, quantity: 1, idempotencyKey: 'downstream-local-key',
        orderFieldsValues: { player_id: 'player-123' },
    });
    await Order.findByIdAndUpdate(created.order._id, { $set: { status: ORDER_STATUS.PROCESSING, executionType: 'automatic' } });
    const fulfillment = await executeOrder(created.order._id);
    const downstreamOrder = await Order.findById(created.order._id);
    expect(fulfillment.placed).toBe(true);
    expect(downstreamOrder.status).toBe(ORDER_STATUS.PROCESSING);
    expect(downstreamOrder.providerOrderId).toMatch(/^ID_/);

    const upstreamOrder = await Order.findOne({ userId: upstreamReseller._id, idempotencyKey: downstreamOrder.orderNumber });
    expect(upstreamOrder).toBeTruthy();
    expect(upstreamOrder.customerInput.values).toEqual({ player_id: 'player-123' });
    expect(upstreamOrder.customerInput.values).not.toHaveProperty('orderId');
    expect(upstreamOrder.customerInput.values).not.toHaveProperty('clientReference');
    expect(upstreamOrder.customerInput.values).not.toHaveProperty('providerIdempotencyKey');
    expect((await freshUser(upstreamReseller._id)).walletBalance).toBe(90);

    const replay = await adapter.placeOrder({
        externalProductId: String(upstreamProduct.compatProductId), quantity: 1, referenceId: downstreamOrder.orderNumber,
        player_id: 'player-123', orderId: 'internal', clientReference: 'internal', providerIdempotencyKey: 'internal',
    });
    expect(replay.providerOrderId).toBe(downstreamOrder.providerOrderId);
    expect(await Order.countDocuments({ userId: upstreamReseller._id, idempotencyKey: downstreamOrder.orderNumber })).toBe(1);
    expect((await freshUser(upstreamReseller._id)).walletBalance).toBe(90);

    const byId = await rawGet(`check?orders=${downstreamOrder.providerOrderId}`, rawToken);
    const byUuid = await rawGet(`check?uuids=${downstreamOrder.orderNumber}`, rawToken);
    expect(byId.body.data[0].order_id).toBe(downstreamOrder.providerOrderId);
    expect(byUuid.body.data[0].order_uuid).toBe(downstreamOrder.orderNumber);
});

test('recovers a post-dispatch transport failure through the real upstream UUID lookup without replacing', async () => {
    const token = 'local-canonical-recovery-token';
    const { customer: reseller } = await createCustomerWithGroup({ apiToken: token, isApiEnabled: true, walletBalance: 100, currency: 'USD' }, { percentage: 0 });
    const product = await createProduct({ name: 'Recovery product', basePrice: 10, minQty: 1, maxQty: 1, executionType: 'manual', orderFields: [] });
    const provider = await Provider.create({ name: 'Recovery Canonical Provider', slug: 'recovery-canonical', adapterType: 'canonical-b2b', baseUrl: upstreamBase, apiToken: token, isActive: true });
    const real = axios.create({ baseURL: upstreamBase, headers: { 'api-token': token, 'Content-Type': 'application/json' } });
    const post = jest.fn(async (...args) => {
        await real.post(...args); // upstream commits successfully first
        const error = Object.assign(new Error('socket reset after dispatch'), { code: 'ECONNRESET' });
        throw error;
    });
    const adapter = new CanonicalB2BAdapter(provider, { httpClient: { get: real.get.bind(real), post } });
    const referenceId = 'DOWNSTREAM-STABLE-REFERENCE';
    const recovered = await adapter.placeOrder({ externalProductId: String(product.compatProductId), quantity: 1, referenceId });
    expect(post).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({ success: true, providerStatus: 'wait' });
    expect(await Order.countDocuments({ userId: reseller._id, idempotencyKey: referenceId })).toBe(1);
    expect((await freshUser(reseller._id)).walletBalance).toBe(90);
    const upstreamOrder = await Order.findOne({ userId: reseller._id, idempotencyKey: referenceId });
    expect(recovered.providerOrderId).toBe(upstreamOrder.compatOrderId);
});

test('canonical unresolved placement polls by reference then reaches manual review without refund or replacement', async () => {
    const token = 'local-canonical-unresolved-token';
    const { customer: upstream } = await createCustomerWithGroup({ apiToken: token, isApiEnabled: true, walletBalance: 100, currency: 'USD' }, { percentage: 0 });
    const provider = await Provider.create({ name: 'Unresolved Canonical Provider', slug: 'unresolved-canonical', adapterType: 'canonical-b2b', baseUrl: upstreamBase, apiToken: token, isActive: true });
    const { customer: downstream } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' }, { percentage: 0 });
    const product = await createProduct({ name: 'Unresolved downstream product', basePrice: 10, executionType: 'manual' });
    const { order } = await orderService.createOrder({ userId: downstream._id, productId: product._id, quantity: 1, idempotencyKey: 'unresolved-local-key', orderFieldsValues: {} });
    await Order.findByIdAndUpdate(order._id, { $set: {
        status: ORDER_STATUS.PROCESSING, executionType: 'automatic', providerCode: provider.slug,
        providerStatus: 'PLACEMENT_UNCERTAIN', providerOrderId: null, outcomeUncertain: true, retryCount: MAX_RETRY_COUNT - 1,
    } });
    const stats = await pollProcessingOrders();
    const reloaded = await Order.findById(order._id);
    expect(stats.manualReview).toBe(1);
    expect(reloaded.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
    expect(reloaded.providerOrderId).toBeNull();
    expect(reloaded.refunded).toBe(false);
    expect(reloaded.outcomeUncertain).toBe(true);
    expect(await Order.countDocuments({ userId: upstream._id })).toBe(0);
    expect((await freshUser(downstream._id)).walletBalance).toBe(90);
});
