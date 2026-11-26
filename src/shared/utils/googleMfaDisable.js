'use strict';

const { BusinessRuleError } = require('../errors/AppError');

const rejectMfaDisable = (_req, _res, next) => {
    next(new BusinessRuleError(
        'Two-factor authentication is required for every account and cannot be disabled.',
        'TWO_FACTOR_REQUIRED'
    ));
};

module.exports = { request: rejectMfaDisable, confirm: rejectMfaDisable };
