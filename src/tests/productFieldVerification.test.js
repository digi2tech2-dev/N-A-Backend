'use strict';

const { ProductFieldVerificationService } = require('../modules/products/productFieldVerification.service');
const { BusinessRuleError } = require('../shared/errors/AppError');

const provider = { _id: 'provider_1', slug: 'hago', isActive: true, deletedAt: null };
const product = (fields) => ({ provider: provider._id, orderFields: fields, dynamicFields: [] });
const configuredField = (overrides = {}) => ({
    key: 'target_uid',
    label: 'Hago ID',
    type: 'text',
    required: true,
    verification: { enabled: true, strategy: 'provider', providerCapability: 'target_identity' },
    ...overrides,
});

const makeService = ({ verification, providerDoc = provider } = {}) => {
    const providerModel = {
        findById: jest.fn(() => ({ select: jest.fn().mockResolvedValue(providerDoc) })),
    };
    const hagoService = {
        verifyTarget: jest.fn().mockResolvedValue({
            verification: { uid: 'uid_1', vid: '361792488', nickName: 'Ahmed', country: 'EG', connectionId: 'never-return' },
        }),
    };
    if (verification) hagoService.verifyTarget = verification;
    return { service: new ProductFieldVerificationService({ providerModel, hagoService }), hagoService };
};

describe('product field provider verification', () => {
    it('rejects an unknown field and a field without provider verification enabled', async () => {
        const { service } = makeService();
        await expect(service.verifyField({ product: product([configuredField()]), fieldKey: 'unknown', value: '1' }))
            .rejects.toMatchObject({ code: 'PRODUCT_FIELD_NOT_FOUND' });
        await expect(service.verifyField({ product: product([configuredField({ verification: { enabled: false } })]), fieldKey: 'target_uid', value: '1' }))
            .rejects.toMatchObject({ code: 'PRODUCT_FIELD_VERIFICATION_NOT_ENABLED' });
    });

    it('requires a value and returns only normalized customer-safe Hago identity data', async () => {
        const { service, hagoService } = makeService();
        await expect(service.verifyField({ product: product([configuredField()]), fieldKey: 'target_uid', value: ' ' }))
            .rejects.toMatchObject({ code: 'PRODUCT_FIELD_VALUE_REQUIRED' });

        await expect(service.verifyField({ product: product([configuredField()]), fieldKey: 'target_uid', value: '361792488' }))
            .resolves.toEqual({
                verified: true,
                fieldKey: 'target_uid',
                identity: { displayName: 'Ahmed', vid: '361792488', country: 'EG' },
            });
        expect(hagoService.verifyTarget).toHaveBeenCalledWith('provider_1', { targetId: '361792488' });
    });

    it('returns safe invalid-target and upstream failures without exposing provider details', async () => {
        const invalid = makeService({
            verification: jest.fn().mockRejectedValue(new BusinessRuleError('upstream said no', 'HAGO_INVALID_TARGET')),
        });
        await expect(invalid.service.verifyField({ product: product([configuredField()]), fieldKey: 'target_uid', value: 'bad' }))
            .rejects.toMatchObject({ code: 'HAGO_INVALID_TARGET', message: 'The Hago ID is invalid or unavailable.' });

        const unavailable = makeService({
            verification: jest.fn().mockRejectedValue(new Error('token=private-value connection=private')),
        });
        await expect(unavailable.service.verifyField({ product: product([configuredField()]), fieldKey: 'target_uid', value: '1' }))
            .rejects.toMatchObject({ code: 'PRODUCT_FIELD_PROVIDER_UNAVAILABLE', message: 'Provider verification is temporarily unavailable.' });
    });

    it('rechecks every configured field against the submitted value during order enforcement', async () => {
        const { service, hagoService } = makeService();
        await service.enforceRequiredFields({ product: product([configuredField()]), values: { target_uid: '361792488' } });
        expect(hagoService.verifyTarget).toHaveBeenCalledTimes(1);
        await expect(service.enforceRequiredFields({ product: product([configuredField()]), values: { target_uid: '' } }))
            .rejects.toMatchObject({ code: 'PRODUCT_FIELD_VALUE_REQUIRED' });
    });
});
