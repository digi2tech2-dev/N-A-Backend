'use strict';

const crypto = require('crypto');
const { Product, PRICING_STRATEGIES } = require('../../products/product.model');
const { HagoNobilityQuote } = require('./hagoNobilityQuote.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('./hagoProviderConnection.model');
const { HagoClient, HagoClientError, sanitizePayload } = require('./hago.client');
const { calculateUserPrice } = require('../../orders/pricing.service');
const { convertUsdToUserCurrency } = require('../../../services/currencyConverter.service');
const { User } = require('../../users/user.model');
const { toDecimal, toFiat, isPositive } = require('../../../shared/utils/decimalPrecision');
const { AppError, BusinessRuleError, NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const { normalizeIdentity } = require('./hagoConnection.service');

const HAGO_NOBILITY_QUOTE_TTL_MS = (() => {
    const configured = Number.parseInt(process.env.HAGO_NOBILITY_QUOTE_TTL_MS ?? '180000', 10);
    return Number.isFinite(configured) && configured >= 120000 && configured <= 300000
        ? configured
        : 180000;
})();

const NOBILITY_LEVELS = Object.freeze({
    1: 'Knight',
    2: 'Viscount',
    3: 'Earl',
    4: 'Duke',
});

const deriveNobilityType = (providerProduct) => {
    const code = String(providerProduct?.externalProductId ?? '');
    const matched = /^HAGO_NOBILITY_([1-4])$/.exec(code);
    return matched ? Number(matched[1]) : null;
};

const upper = (value) => String(value ?? '').trim().toUpperCase();
const positiveNumberOrNull = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

const resolveOperation = (readiness, selectedType) => {
    const named = upper(readiness?.derivedBuyTypeName);
    if (/(RENEW|RENEWAL)/.test(named)) return 'RENEW';
    if (/(PURCHASE|BUY|UPGRADE)/.test(named)) return 'PURCHASE';
    const currentType = Number(readiness?.current?.type ?? readiness?.currentType ?? readiness?.currentNobilityType);
    if (Number.isInteger(currentType)) {
        if (selectedType === currentType) return 'RENEW';
        if (selectedType > currentType) return 'PURCHASE';
    }
    if (!currentType) return 'PURCHASE';
    return null;
};

const normalizedReadiness = (response, selectedType) => {
    const safe = sanitizePayload(response);
    const value = safe?.nobilityPurchaseReadiness ?? safe?.readiness ?? safe ?? {};
    const currentTypeValue = Number(value?.current?.type ?? value?.currentType ?? value?.currentNobilityType);
    return {
        selectedType: Number(value.selectedType ?? selectedType),
        selectedName: String(value.selectedName ?? NOBILITY_LEVELS[selectedType] ?? ''),
        currentType: Number.isInteger(currentTypeValue) ? currentTypeValue : null,
        remainingDays: positiveNumberOrNull(value?.current?.remainingDays ?? value?.remainingDays),
        operation: resolveOperation(value, selectedType),
        diamondCost: positiveNumberOrNull(value.diamondCost),
        packAvailable: value.packAvailable !== false,
        walletSufficient: value?.wallet?.sufficient !== false,
        lowerTierBlocked: value.lowerTierBlocked === true,
        confirmationRequired: value.confirmationRequired === true,
        technicallyEligible: value.technicallyEligible !== false,
        blockReason: typeof value.blockReason === 'string' ? value.blockReason : null,
    };
};

const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quoteRef = () => crypto.randomBytes(24).toString('base64url');

const serializeQuote = (quote, identity, readiness) => ({
    quoteRef: quote.quoteRef,
    expiresAt: quote.expiresAt,
    target: {
        requestedId: quote.targetId,
        uid: identity.uid,
        vid: identity.vid,
        nickName: identity.nickName,
        country: identity.country,
    },
    nobility: {
        type: quote.selectedType,
        name: quote.selectedName,
        operation: quote.operation,
        currentType: readiness.currentType,
        remainingDays: readiness.remainingDays,
        confirmationRequired: false,
    },
    pricing: {
        finalPrice: quote.finalPrice,
        currency: quote.currency,
    },
});

class HagoNobilityCommerceService {
    constructor({ productModel = Product, quoteModel = HagoNobilityQuote, connectionModel = HagoProviderConnection, client = new HagoClient(), calculatePrice = calculateUserPrice, convertCurrency = convertUsdToUserCurrency, userModel = User, now = () => new Date() } = {}) {
        this.Product = productModel;
        this.Quote = quoteModel;
        this.Connection = connectionModel;
        this.client = client;
        this.calculatePrice = calculatePrice;
        this.convertCurrency = convertCurrency;
        this.User = userModel;
        this.now = now;
    }

    _safeHagoError(error, operation) {
        if (error instanceof AppError) return error;
        if (error instanceof HagoClientError) {
            const status = error.code === 'HAGO_UPSTREAM_TIMEOUT' ? 504
                : error.code === 'HAGO_UPSTREAM_UNAVAILABLE' || error.code === 'HAGO_CONFIGURATION_ERROR' ? 503 : 502;
            return new AppError(`Hago ${operation} is unavailable.`, status, error.code);
        }
        return new AppError(`Hago ${operation} is unavailable.`, 502, 'HAGO_REQUEST_FAILED');
    }

    async _resolve(productId) {
        const product = await this.Product.findById(productId)
            .populate('provider', 'slug isActive deletedAt')
            .populate('providerProduct', 'externalProductId rawName isActive rawPayload');
        if (!product || product.deletedAt || !product.isActive) throw new NotFoundError('Product');
        if (product.pricingStrategy !== PRICING_STRATEGIES.HAGO_NOBILITY_READINESS
            || product.provider?.slug !== 'hago'
            || !product.provider?.isActive
            || !product.providerProduct?.isActive) {
            throw new BusinessRuleError('This product is not configured for Hago Nobility readiness.', 'HAGO_NOBILITY_PRODUCT_REQUIRED');
        }
        const selectedType = deriveNobilityType(product.providerProduct);
        if (!selectedType) throw new BusinessRuleError('The Hago Nobility product configuration is unsupported.', 'HAGO_NOBILITY_UNSUPPORTED_CONFIGURATION');
        const pricing = product.hagoNobilityPricing;
        if (!isPositive(pricing?.purchaseBasePrice) || !isPositive(pricing?.renewalBasePrice)) {
            throw new BusinessRuleError('Hago Nobility selling prices have not been configured.', 'HAGO_NOBILITY_PRICING_NOT_CONFIGURED');
        }
        const connection = await this.Connection.findOne({ provider: product.provider._id, isPrimary: true, enabled: true })
            .select('+connectionId');
        if (!connection?.connectionId) throw new BusinessRuleError('No enabled Hago connection is available.', 'HAGO_CONNECTION_UNAVAILABLE');
        if (connection.connectionStatus === CONNECTION_STATUS.REAUTH_REQUIRED) {
            throw new BusinessRuleError('The Hago connection requires reauthentication.', 'HAGO_SESSION_REAUTH_REQUIRED');
        }
        return { product, connection, selectedType, pricing };
    }

    _enforceReadiness(readiness) {
        if (readiness.lowerTierBlocked) throw new BusinessRuleError(readiness.blockReason || 'The selected Nobility level is lower than the current level.', 'HAGO_NOBILITY_LOWER_TIER_BLOCKED');
        if (!readiness.packAvailable) throw new BusinessRuleError(readiness.blockReason || 'This Nobility package is unavailable.', 'HAGO_NOBILITY_PACK_UNAVAILABLE');
        if (!readiness.walletSufficient) throw new BusinessRuleError('The Hago provider balance is insufficient.', 'HAGO_NOBILITY_INSUFFICIENT_PROVIDER_BALANCE');
        if (!readiness.technicallyEligible) throw new BusinessRuleError(readiness.blockReason || 'This Hago target is not eligible.', 'HAGO_NOBILITY_NOT_ELIGIBLE');
        if (readiness.confirmationRequired) throw new BusinessRuleError('Hago requires additional confirmation for this level change.', 'HAGO_NOBILITY_CONFIRMATION_REQUIRED');
        if (!['PURCHASE', 'RENEW'].includes(readiness.operation)) throw new BusinessRuleError('Hago returned an unsupported Nobility operation.', 'HAGO_NOBILITY_UNSUPPORTED_CONFIGURATION');
    }

    async createReadinessQuote({ userId, productId, targetId }) {
        const normalizedTargetId = String(targetId ?? '').trim();
        if (!normalizedTargetId) throw new ValidationError('targetId is required.');
        const { product, connection, selectedType, pricing } = await this._resolve(productId);
        let identity;
        let upstream;
        try {
            identity = normalizeIdentity(await this.client.verifyTarget(connection.connectionId, normalizedTargetId), normalizedTargetId);
        } catch (error) {
            if (error instanceof HagoClientError && [400, 404].includes(error.statusCode)) {
                throw new BusinessRuleError('The Hago ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
            }
            throw this._safeHagoError(error, 'target verification');
        }
        try {
            upstream = await this.client.nobilityPurchaseReadiness(connection.connectionId, normalizedTargetId, selectedType);
        } catch (error) {
            throw this._safeHagoError(error, 'Nobility readiness check');
        }
        if (!identity.uid && !identity.vid) {
            throw new BusinessRuleError('The Hago ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
        }
        const readiness = normalizedReadiness(upstream, selectedType);
        this._enforceReadiness(readiness);
        const pricingBranch = readiness.operation === 'RENEW' ? 'renewal' : 'purchase';
        const branchBasePrice = pricingBranch === 'renewal' ? pricing.renewalBasePrice : pricing.purchaseBasePrice;
        const userPricing = await this.calculatePrice(userId, branchBasePrice);
        const user = await this.User.findById(userId).select('currency');
        if (!user) throw new NotFoundError('User');
        const conversion = await this.convertCurrency(Number(toDecimal(userPricing.finalPrice).toNumber()), user.currency ?? 'USD');
        const finalPrice = String(toFiat(conversion.finalAmount));
        const now = this.now();
        const expiresAt = new Date(now.getTime() + HAGO_NOBILITY_QUOTE_TTL_MS);
        const quote = await this.Quote.create({
            quoteRef: quoteRef(),
            userId,
            productId: product._id,
            targetId: normalizedTargetId,
            selectedType,
            selectedName: NOBILITY_LEVELS[selectedType],
            operation: readiness.operation,
            pricingBranch,
            branchBasePrice: String(branchBasePrice),
            finalPrice,
            usdAmount: String(userPricing.finalPrice),
            currency: conversion.currency,
            groupId: userPricing.groupId,
            markupPercentage: userPricing.markupPercentage,
            readinessAt: now,
            readinessConfigFingerprint: fingerprint({ selectedType, operation: readiness.operation, diamondCost: readiness.diamondCost, branchBasePrice, packAvailable: readiness.packAvailable }),
            connectionRef: connection._id,
            expiresAt,
        });
        return { quote: serializeQuote(quote, identity, readiness) };
    }

    async validateQuote({ quoteRef: reference, userId, productId, targetId }) {
        const quote = await this.Quote.findOne({ quoteRef: String(reference ?? '') }).select('+targetId');
        if (!quote || quote.expiresAt <= this.now()) throw new BusinessRuleError('This Hago Nobility quote has expired. Refresh the quote and try again.', 'HAGO_NOBILITY_QUOTE_EXPIRED');
        if (String(quote.userId) !== String(userId) || String(quote.productId) !== String(productId) || String(quote.targetId) !== String(targetId ?? '').trim()) {
            throw new BusinessRuleError('This Hago Nobility quote does not match the requested checkout.', 'HAGO_NOBILITY_QUOTE_MISMATCH');
        }
        return quote;
    }
}

const hagoNobilityCommerceService = new HagoNobilityCommerceService();

module.exports = {
    HagoNobilityCommerceService,
    hagoNobilityCommerceService,
    HAGO_NOBILITY_QUOTE_TTL_MS,
    NOBILITY_LEVELS,
    deriveNobilityType,
    normalizedReadiness,
};
