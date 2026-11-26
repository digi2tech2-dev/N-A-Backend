'use strict';

const { request, confirm } = require('../shared/utils/googleMfaDisable');

const invoke = (handler) => new Promise((resolve, reject) => {
    handler({ user: { _id: 'account-id' }, body: {} }, {}, error => error ? reject(error) : resolve());
});

test.each([['request', request], ['confirm', confirm]])('%s cannot disable mandatory MFA', async (_name, handler) => {
    await expect(invoke(handler)).rejects.toMatchObject({
        statusCode: 422,
        code: 'TWO_FACTOR_REQUIRED',
    });
});
