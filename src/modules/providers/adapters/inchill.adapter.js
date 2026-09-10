'use strict';
const { BaseProviderAdapter } = require('./base.adapter');

// Inchill's V1 API has no commercial catalog. This synthetic provider product
// is solely a stable Product/ProviderProduct association for Diamond execution.
class InchillAdapter extends BaseProviderAdapter {
    static supportedFeatures = ['getProducts'];
    async getProducts() {
        return [{ externalProductId: 'INCHILL_DIAMOND_AMOUNT', rawName: 'Inchill Diamond', rawPrice: '0', minQty: 1, maxQty: 999999999, isActive: true, rawPayload: { metadata: { serviceType: 'DIAMOND', source: 'inchill-v1' } } }];
    }
    async placeOrder() { throw new Error('Inchill financial orders require the controlled Inchill executor.'); }
    async checkOrder() { throw new Error('Inchill status must use reconciliation evidence.'); }
}
module.exports = { InchillAdapter };
