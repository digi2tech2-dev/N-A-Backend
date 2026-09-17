'use strict';

const SENSITIVE_FIELDS = [
    'providerPrice',
    'markupType',
    'markupValue',
    'pricingMode',
    'hagoNobilityPricing',
    'provider',
    'providerProduct',
    'providerMapping',
    'syncPriceWithProvider',
    'enableManualPrice',
    'manualPriceAdjustment',
    'executionType',
    'createdBy',
    'deletedAt',
    'internalNotes',
    'syncedProviderBasePrice',
    'supplierId',
    'providerId',
    'externalProductId',
    'externalProductName',
    'costPrice',
    '__v',
];

const sanitizeProductForCustomer = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    const providerSlug = String(obj.provider?.slug ?? '').toLowerCase();
    const externalProductId = String(obj.providerProduct?.externalProductId ?? '');
    obj.isInchillDiamond = providerSlug === 'inchill' && (
        externalProductId === 'INCHILL_DIAMOND_AMOUNT'
        || obj.providerProduct?.rawPayload?.metadata?.serviceType === 'DIAMOND'
    );
    obj.requiresInchillTargetVerification = obj.isInchillDiamond;
    for (const field of SENSITIVE_FIELDS) delete obj[field];
    obj.showAccountNumber = Boolean(obj.showAccountNumber);
    obj.displayAccountNumber = obj.showAccountNumber
        ? (obj.displayAccountNumber || null)
        : null;
    return obj;
};

const sanitizeProductsForCustomer = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForCustomer);

module.exports = { sanitizeProductForCustomer, sanitizeProductsForCustomer };
