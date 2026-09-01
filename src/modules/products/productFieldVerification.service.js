'use strict';

const { Provider } = require('../providers/provider.model');
const { hagoConnectionService } = require('../providers/hago/hagoConnection.service');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const {
    FIELD_VERIFICATION_STRATEGIES,
    FIELD_VERIFICATION_CAPABILITIES,
} = require('./product.model');

const LEGACY_PROVIDER_VERIFICATION = Object.freeze({
    enabled: true,
    strategy: FIELD_VERIFICATION_STRATEGIES.PROVIDER,
    providerCapability: FIELD_VERIFICATION_CAPABILITIES.TARGET_IDENTITY,
});

const fieldKey = (field) => String(field?.key ?? field?.name ?? '').trim();

const configuredVerification = (field) => {
    if (field?.verification?.enabled === true) {
        return {
            enabled: true,
            strategy: field.verification.strategy,
            providerCapability: field.verification.providerCapability,
        };
    }

    // Existing products used this boolean before the capability-based schema.
    // Preserve their customer flow while all newly saved fields use `verification`.
    return field?.isVerifiable === true ? { ...LEGACY_PROVIDER_VERIFICATION } : null;
};

const configuredFields = (product) => {
    const fields = Array.isArray(product?.orderFields) && product.orderFields.length > 0
        ? product.orderFields
        : (Array.isArray(product?.dynamicFields) ? product.dynamicFields : []);
    return fields.filter((field) => field?.isActive !== false && field?.enabled !== false);
};

const normalizeIdentity = (verification) => ({
    displayName: verification?.nickName ?? null,
    vid: verification?.vid ?? null,
    country: verification?.country ?? null,
});

class ProductFieldVerificationService {
    constructor({ providerModel = Provider, hagoService = hagoConnectionService } = {}) {
        this.Provider = providerModel;
        this.hagoService = hagoService;
    }

    findConfiguredField(product, key) {
        const requestedKey = String(key ?? '').trim();
        const field = configuredFields(product).find((candidate) => fieldKey(candidate) === requestedKey);
        if (!field) {
            throw new BusinessRuleError('The requested product field is not available.', 'PRODUCT_FIELD_NOT_FOUND');
        }

        const verification = configuredVerification(field);
        if (!verification) {
            throw new BusinessRuleError('This product field does not support provider verification.', 'PRODUCT_FIELD_VERIFICATION_NOT_ENABLED');
        }
        if (
            verification.strategy !== FIELD_VERIFICATION_STRATEGIES.PROVIDER
            || verification.providerCapability !== FIELD_VERIFICATION_CAPABILITIES.TARGET_IDENTITY
        ) {
            throw new BusinessRuleError('This product field verification capability is unavailable.', 'PRODUCT_FIELD_VERIFICATION_UNSUPPORTED');
        }
        return { field, verification };
    }

    async verifyField({ product, fieldKey: requestedKey, value }) {
        const { field } = this.findConfiguredField(product, requestedKey);
        const normalizedValue = String(value ?? '').trim();
        if (!normalizedValue) {
            throw new BusinessRuleError('A field value is required for verification.', 'PRODUCT_FIELD_VALUE_REQUIRED');
        }
        if (!product?.provider) {
            throw new BusinessRuleError('Provider verification is unavailable for this product.', 'PRODUCT_FIELD_PROVIDER_UNAVAILABLE');
        }

        const provider = await this.Provider.findById(product.provider).select('slug isActive deletedAt');
        if (!provider || provider.deletedAt || !provider.isActive) {
            throw new BusinessRuleError('Provider verification is temporarily unavailable.', 'PRODUCT_FIELD_PROVIDER_UNAVAILABLE');
        }
        if (provider.slug !== 'hago') {
            throw new BusinessRuleError('This provider verification capability is unavailable.', 'PRODUCT_FIELD_VERIFICATION_UNSUPPORTED');
        }

        let result;
        try {
            result = await this.hagoService.verifyTarget(provider._id, { targetId: normalizedValue });
        } catch (error) {
            if (error?.code === 'HAGO_INVALID_TARGET') {
                throw new BusinessRuleError('The Hago ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
            }
            const safeCode = [
                'HAGO_UPSTREAM_TIMEOUT',
                'HAGO_UPSTREAM_UNAVAILABLE',
                'HAGO_REQUEST_FAILED',
                'HAGO_CONFIGURATION_ERROR',
                'HAGO_CONNECTION_UNAVAILABLE',
                'HAGO_SESSION_REAUTH_REQUIRED',
            ].includes(error?.code)
                ? error.code
                : 'PRODUCT_FIELD_PROVIDER_UNAVAILABLE';
            throw new BusinessRuleError('Provider verification is temporarily unavailable.', safeCode);
        }

        const identity = normalizeIdentity(result?.verification);
        if (!identity.vid && !result?.verification?.uid) {
            throw new BusinessRuleError('The Hago ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
        }

        return {
            verified: true,
            fieldKey: fieldKey(field),
            identity,
        };
    }

    async enforceRequiredFields({ product, values }) {
        const submittedValues = values && typeof values === 'object' ? values : {};
        const requiredFields = configuredFields(product).filter((field) => configuredVerification(field));
        for (const field of requiredFields) {
            const key = fieldKey(field);
            await this.verifyField({ product, fieldKey: key, value: submittedValues[key] });
        }
    }
}

const productFieldVerificationService = new ProductFieldVerificationService();

module.exports = {
    ProductFieldVerificationService,
    productFieldVerificationService,
    configuredVerification,
    configuredFields,
};
