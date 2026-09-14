'use strict';

const { InchillCustomerTargetVerificationService } = require('../modules/providers/inchill/inchillCustomerTargetVerification.service');
const { BusinessRuleError } = require('../shared/errors/AppError');

const provider = { _id: 'provider_1', slug: 'inchill', isActive: true, deletedAt: null };
const providerProduct = {
    provider: provider._id,
    externalProductId: 'INCHILL_DIAMOND_AMOUNT',
    rawPayload: { metadata: { serviceType: 'DIAMOND' } },
    isActive: true,
};
const product = { provider: provider._id, providerProduct: 'provider_product_1' };

const query = (value) => ({ select: jest.fn().mockResolvedValue(value) });
const makeService = ({ providerDoc = provider, providerProductDoc = providerProduct, verifyTarget } = {}) => {
    const connectionService = {
        verifyTarget: verifyTarget ?? jest.fn().mockResolvedValue({
            verification: {
                vid: '51511', nickName: 'Safe player', country: 'EG',
                agentPhone: '+201234567890', connectionRef: 'private', raw: { token: 'secret' },
            },
        }),
    };
    return {
        connectionService,
        service: new InchillCustomerTargetVerificationService({
            providerModel: { findById: jest.fn(() => query(providerDoc)) },
            providerProductModel: { findById: jest.fn(() => query(providerProductDoc)) },
            connectionService,
        }),
    };
};

describe('customer Inchill target verification', () => {
    it('returns only the minimal customer-safe identity from the existing read-only verifier', async () => {
        const { service, connectionService } = makeService();
        const result = await service.verifyTarget({ product, targetId: ' 51511 ' });

        expect(connectionService.verifyTarget).toHaveBeenCalledWith('provider_1', { targetId: '51511' });
        expect(result).toEqual({ verified: true, targetId: '51511', displayName: 'Safe player', vid: '51511', country: 'EG' });
        expect(JSON.stringify(result)).not.toMatch(/agentPhone|connectionRef|secret|raw|token/i);
    });

    it('maps invalid and upstream failures to safe customer errors', async () => {
        const invalid = makeService({ verifyTarget: jest.fn().mockRejectedValue(new BusinessRuleError('raw upstream reason', 'INCHILL_TARGET_INVALID')) });
        await expect(invalid.service.verifyTarget({ product, targetId: 'bad' }))
            .rejects.toMatchObject({ code: 'INCHILL_TARGET_INVALID', message: 'The Inchill ID is invalid or unavailable.' });

        const unavailable = makeService({ verifyTarget: jest.fn().mockRejectedValue(new Error('agent=+2012 token=private')) });
        await expect(unavailable.service.verifyTarget({ product, targetId: '51511' }))
            .rejects.toMatchObject({ code: 'INCHILL_PROVIDER_UNAVAILABLE', message: 'Inchill target verification is temporarily unavailable.' });
    });

    it('rejects products that are not an active linked Inchill Diamond service', async () => {
        const nonInchill = makeService({ providerDoc: { ...provider, slug: 'hago' } });
        await expect(nonInchill.service.verifyTarget({ product, targetId: '51511' }))
            .rejects.toMatchObject({ code: 'INCHILL_PRODUCT_REQUIRED' });

        const disconnectedProduct = makeService({ providerProductDoc: { ...providerProduct, isActive: false } });
        await expect(disconnectedProduct.service.verifyTarget({ product, targetId: '51511' }))
            .rejects.toMatchObject({ code: 'INCHILL_PRODUCT_REQUIRED' });
    });

    it('cannot treat a prior target verification as valid for a changed submitted target', async () => {
        const { service, connectionService } = makeService();
        await service.verifyTarget({ product, targetId: '51511' });
        await service.verifyTarget({ product, targetId: '51512' });
        expect(connectionService.verifyTarget).toHaveBeenLastCalledWith('provider_1', { targetId: '51512' });
        expect(connectionService.verifyTarget).toHaveBeenCalledTimes(2);
    });
});
