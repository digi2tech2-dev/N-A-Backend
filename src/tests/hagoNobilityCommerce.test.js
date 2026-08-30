'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_MODES, PRICING_STRATEGIES } = require('../modules/products/product.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('../modules/providers/hago/hagoProviderConnection.model');
const { HagoNobilityQuote } = require('../modules/providers/hago/hagoNobilityQuote.model');
const { HagoNobilityCommerceService } = require('../modules/providers/hago/hagoNobilityCommerce.service');
const orderService = require('../modules/orders/order.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB, disconnectTestDB, clearCollections, createGroup, createCustomer,
} = require('./testHelpers');

const makeClient = (readiness = {}) => ({
    verifyTarget: jest.fn().mockResolvedValue({ userInfo: { uid: 'uid_1', vid: '51511', nick: 'Player', country: 'EG', token: 'hidden' } }),
    nobilityPurchaseReadiness: jest.fn().mockResolvedValue({
        nobilityPurchaseReadiness: { selectedType: 1, selectedName: 'Knight', derivedBuyTypeName: 'PURCHASE', packAvailable: true, wallet: { sufficient: true }, technicallyEligible: true, ...readiness },
    }),
});

const fixture = async ({ pricing = { purchaseBasePrice: '100', renewalBasePrice: '50' } } = {}) => {
    const group = await createGroup({ percentage: 20 });
    const user = await createCustomer({ groupId: group._id, currency: 'USD', walletBalance: 500 });
    const provider = await Provider.create({ name: `Hago ${Date.now()}`, slug: 'hago', baseUrl: 'https://provider.invalid', syncInterval: 0 });
    const providerProduct = await ProviderProduct.create({ provider: provider._id, externalProductId: 'HAGO_NOBILITY_1', rawName: 'Hago Knight', rawPrice: '0', minQty: 1, maxQty: 1, rawPayload: { metadata: { serviceType: 'NOBILITY', nobilityType: 1 } } });
    const product = await Product.create({ name: `Knight ${Date.now()}`, basePrice: pricing.purchaseBasePrice, minQty: 1, maxQty: 1, provider: provider._id, providerProduct: providerProduct._id, pricingMode: PRICING_MODES.MANUAL, pricingStrategy: PRICING_STRATEGIES.HAGO_NOBILITY_READINESS, hagoNobilityPricing: pricing });
    const connection = await HagoProviderConnection.create({ provider: provider._id, connectionId: 'con_internal', isPrimary: true, enabled: true, connectionStatus: CONNECTION_STATUS.CONNECTED });
    return { group, user, provider, providerProduct, product, connection };
};

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => clearCollections());

describe('Hago Nobility read-only readiness quotes', () => {
    it('derives PURCHASE server-side, applies the selected branch plus group pricing, and serializes no secrets', async () => {
        const { user, product } = await fixture();
        const client = makeClient();
        const service = new HagoNobilityCommerceService({ client });
        const { quote } = await service.createReadinessQuote({ userId: user._id, productId: product._id, targetId: '51511' });

        expect(client.nobilityPurchaseReadiness).toHaveBeenCalledWith('con_internal', '51511', 1);
        expect(quote).toMatchObject({
            target: { requestedId: '51511', uid: 'uid_1', vid: '51511', nickName: 'Player', country: 'EG' },
            nobility: { type: 1, name: 'Knight', operation: 'PURCHASE' },
            pricing: { finalPrice: '120', currency: 'USD' },
        });
        expect(JSON.stringify(quote)).not.toContain('con_internal');
        expect(JSON.stringify(quote)).not.toContain('hidden');
        expect(await HagoNobilityQuote.countDocuments()).toBe(1);
    });

    it('uses the renewal branch and fails closed for lower tier, unavailable packs, insufficient wallet, and confirmation', async () => {
        const { user, product } = await fixture();
        const renewal = new HagoNobilityCommerceService({ client: makeClient({ derivedBuyTypeName: 'RENEW' }) });
        await expect(renewal.createReadinessQuote({ userId: user._id, productId: product._id, targetId: '51511' }))
            .resolves.toMatchObject({ quote: { nobility: { operation: 'RENEW' }, pricing: { finalPrice: '60' } } });

        for (const [override, code] of [
            [{ lowerTierBlocked: true }, 'HAGO_NOBILITY_LOWER_TIER_BLOCKED'],
            [{ packAvailable: false }, 'HAGO_NOBILITY_PACK_UNAVAILABLE'],
            [{ wallet: { sufficient: false } }, 'HAGO_NOBILITY_INSUFFICIENT_PROVIDER_BALANCE'],
            [{ confirmationRequired: true }, 'HAGO_NOBILITY_CONFIRMATION_REQUIRED'],
        ]) {
            const service = new HagoNobilityCommerceService({ client: makeClient(override) });
            await expect(service.createReadinessQuote({ userId: user._id, productId: product._id, targetId: '51511' }))
                .rejects.toMatchObject({ code });
        }
    });

    it('binds quotes to the user, product, target, and expiry', async () => {
        const { user, product } = await fixture();
        const service = new HagoNobilityCommerceService({ client: makeClient() });
        const { quote } = await service.createReadinessQuote({ userId: user._id, productId: product._id, targetId: '51511' });
        await expect(service.validateQuote({ quoteRef: quote.quoteRef, userId: user._id, productId: product._id, targetId: '51511' })).resolves.toBeTruthy();
        await expect(service.validateQuote({ quoteRef: quote.quoteRef, userId: user._id, productId: product._id, targetId: 'different' }))
            .rejects.toMatchObject({ code: 'HAGO_NOBILITY_QUOTE_MISMATCH' });
        await HagoNobilityQuote.updateOne({ quoteRef: quote.quoteRef }, { $set: { expiresAt: new Date(Date.now() - 1) } });
        await expect(service.validateQuote({ quoteRef: quote.quoteRef, userId: user._id, productId: product._id, targetId: '51511' }))
            .rejects.toMatchObject({ code: 'HAGO_NOBILITY_QUOTE_EXPIRED' });
    });

    it('rejects an invalid Hago target without creating a quote', async () => {
        const { user, product } = await fixture();
        const client = makeClient();
        client.verifyTarget.mockResolvedValueOnce({ userInfo: {} });
        const service = new HagoNobilityCommerceService({ client });
        await expect(service.createReadinessQuote({ userId: user._id, productId: product._id, targetId: 'bad' }))
            .rejects.toMatchObject({ code: 'HAGO_INVALID_TARGET' });
        expect(await HagoNobilityQuote.countDocuments()).toBe(0);
    });
});

describe('Hago Nobility financial guard', () => {
    it('rejects normal order creation before a wallet debit or provider call', async () => {
        const { user, product } = await fixture();
        await expect(orderService.createOrder({ userId: user._id, productId: product._id, quantity: 1 }))
            .rejects.toMatchObject({ code: 'HAGO_NOBILITY_CHECKOUT_NOT_ENABLED' });
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });
});
