'use strict';

const { BaseProviderAdapter } = require('./base.adapter');
const { HagoClient, HagoClientError, sanitizePayload } = require('../hago/hago.client');

const HAGO_SUPPORTED_FEATURES = Object.freeze([
    'fetchProducts',
    'getBalance',
    'getAccount',
    'validateUser',
    'sessionValidation',
    'previews',
    'reconciliation',
]);

const nonPricedProduct = ({ externalProductId, rawName, minQty, maxQty, metadata }) => ({
    externalProductId,
    rawName,
    // Hago V2 supplies no commercial catalog price. Zero represents an
    // intentionally non-priced synthetic record, not a provider cost.
    rawPrice: '0',
    minQty,
    // null means "not documented", unlike the existing generic default 9999.
    maxQty: maxQty ?? null,
    isActive: true,
    rawPayload: {
        source: 'hago-v2-synthetic',
        pricing: 'manual_n_and_a_configuration_required',
        ...metadata,
    },
});

const buildSyntheticProducts = () => [
    nonPricedProduct({
        externalProductId: 'HAGO_DIAMOND_AMOUNT',
        rawName: 'Hago Diamond',
        minQty: 1,
        metadata: { serviceType: 'DIAMOND', amountMode: 'dynamic' },
    }),
    nonPricedProduct({
        externalProductId: 'HAGO_CRYSTAL_AMOUNT',
        rawName: 'Hago Crystal',
        minQty: 1,
        metadata: { serviceType: 'CRYSTAL', amountMode: 'dynamic' },
    }),
    ...[1, 2, 3, 4].map((nobilityType) => nonPricedProduct({
        externalProductId: `HAGO_NOBILITY_${nobilityType}`,
        rawName: `Hago Nobility Type ${nobilityType}`,
        minQty: 1,
        maxQty: 1,
        metadata: { serviceType: 'NOBILITY', nobilityType, amountMode: 'fixed' },
    })),
];

class HagoAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        // Hago authentication is exclusively server environment configuration.
        // Deliberately do not call _resolveToken() or read Provider.apiToken.
        this.client = options.client ?? new HagoClient(options.clientOptions);
    }

    static get supportedFeatures() {
        return [...HAGO_SUPPORTED_FEATURES];
    }

    async getProducts() {
        return buildSyntheticProducts();
    }

    async getBalance(connectionId) {
        // Keep the adapter boundary safe even when an injected client is used
        // by a caller or test fixture rather than the production HagoClient.
        const response = sanitizePayload(await this.client.walletBalance(connectionId));
        return {
            balance: response?.wallet?.balances ?? null,
            wallet: response?.wallet?.balances ?? null,
            rawResponse: response,
        };
    }

    async getMyInfo(connectionId) {
        const response = await this.client.agentProfile(connectionId);
        return {
            profile: sanitizePayload(response),
            rawResponse: sanitizePayload(response),
        };
    }

    async validateUser(targetId, { connectionId } = {}) {
        const response = await this.client.verifyTarget(connectionId, targetId);
        const safe = sanitizePayload(response);
        const identity = safe?.identity ?? safe?.user ?? safe?.target ?? safe?.data ?? safe;

        return {
            targetId: String(targetId).trim(),
            uid: identity?.uid ?? identity?.userId ?? identity?.id ?? null,
            nickName: identity?.nickName ?? identity?.nickname ?? identity?.name ?? null,
            avatar: identity?.avatar ?? null,
        };
    }

    async checkOrder(_orderId) {
        throw new HagoClientError('Hago transaction lookup requires an explicit connectionId.', {
            code: 'HAGO_CONNECTION_ID_REQUIRED',
        });
    }

    async checkOrders(_orderIds) {
        throw new HagoClientError('Hago transaction lookup requires an explicit connectionId.', {
            code: 'HAGO_CONNECTION_ID_REQUIRED',
        });
    }

    async placeOrder() {
        // Phase 1 hard stop: this adapter must never reach a Hago mutation path.
        return {
            success: false,
            providerOrderId: null,
            providerStatus: 'Cancelled',
            rawResponse: { code: 'HAGO_MUTATIONS_DISABLED' },
            errorCode: 'HAGO_MUTATIONS_DISABLED',
            errorMessage: 'Hago financial mutations are disabled.',
        };
    }
}

module.exports = {
    HagoAdapter,
    HAGO_SUPPORTED_FEATURES,
    buildSyntheticProducts,
};
