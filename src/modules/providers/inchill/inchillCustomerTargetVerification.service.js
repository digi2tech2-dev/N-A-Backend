'use strict';

// Customer verification is deliberately separate from Inchill financial
// preflight. It performs only the established read-only target lookup and
// never accepts or returns a connection, agent phone, credentials, cost, or
// mutation-related value.

const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const { inchillConnectionService } = require('./inchillConnection.service');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { isInchillDiamond } = require('./inchillFinancialExecution.service');

class InchillCustomerTargetVerificationService {
    constructor({
        providerModel = Provider,
        providerProductModel = ProviderProduct,
        connectionService = inchillConnectionService,
    } = {}) {
        this.Provider = providerModel;
        this.ProviderProduct = providerProductModel;
        this.connectionService = connectionService;
    }

    async resolveEligibleProduct(product) {
        if (!product?.provider || !product?.providerProduct) {
            throw new BusinessRuleError('This product does not support Inchill target verification.', 'INCHILL_PRODUCT_REQUIRED');
        }

        const [provider, providerProduct] = await Promise.all([
            this.Provider.findById(product.provider).select('slug isActive deletedAt'),
            this.ProviderProduct.findById(product.providerProduct).select('provider externalProductId rawPayload isActive'),
        ]);

        if (
            !provider
            || provider.deletedAt
            || !provider.isActive
            || !providerProduct?.isActive
            || String(providerProduct.provider) !== String(provider._id)
            || !isInchillDiamond(provider, providerProduct)
        ) {
            throw new BusinessRuleError('This product does not support Inchill target verification.', 'INCHILL_PRODUCT_REQUIRED');
        }

        return provider;
    }

    async verifyTarget({ product, targetId }) {
        const normalizedTargetId = String(targetId ?? '').trim();
        if (!normalizedTargetId) {
            throw new BusinessRuleError('An Inchill target ID is required.', 'INCHILL_TARGET_INVALID');
        }

        const provider = await this.resolveEligibleProduct(product);
        let result;
        try {
            result = await this.connectionService.verifyTarget(provider._id, { targetId: normalizedTargetId });
        } catch (error) {
            if (error?.code === 'INCHILL_TARGET_INVALID') {
                throw new BusinessRuleError('The Inchill ID is invalid or unavailable.', 'INCHILL_TARGET_INVALID');
            }
            const safeCode = [
                'INCHILL_CONNECTION_REQUIRED',
                'INCHILL_REAUTHENTICATION_REQUIRED',
                'INCHILL_SESSION_UNKNOWN',
                'INCHILL_TIMEOUT',
                'INCHILL_PROVIDER_UNAVAILABLE',
            ].includes(error?.code)
                ? error.code
                : 'INCHILL_PROVIDER_UNAVAILABLE';
            throw new BusinessRuleError('Inchill target verification is temporarily unavailable.', safeCode);
        }

        const verification = result?.verification ?? {};
        const displayName = verification.nickName == null ? null : String(verification.nickName);
        const vid = verification.vid == null ? null : String(verification.vid);
        const country = verification.country == null ? null : String(verification.country);
        if (!displayName && !vid) {
            throw new BusinessRuleError('The Inchill ID is invalid or unavailable.', 'INCHILL_TARGET_INVALID');
        }

        return {
            verified: true,
            targetId: normalizedTargetId,
            displayName,
            vid,
            country,
        };
    }
}

const inchillCustomerTargetVerificationService = new InchillCustomerTargetVerificationService();

module.exports = {
    InchillCustomerTargetVerificationService,
    inchillCustomerTargetVerificationService,
};
