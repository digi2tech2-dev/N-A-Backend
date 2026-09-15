'use strict';

// The Inchill bot has published both a legacy nested session shape and a
// sanitized top-level status shape.  Normalize only explicit, known statuses;
// an HTTP success with an absent or unfamiliar status remains fail-closed.
const INCHILL_SESSION_VALIDATION_STATUS = Object.freeze({
    VALID: 'VALID',
    REJECTED: 'REJECTED',
    UNKNOWN: 'UNKNOWN',
});

const normalizeStatus = (value) => (
    typeof value === 'string' ? value.trim().toUpperCase() : ''
);

const normalizeInchillSessionValidationStatus = (validation) => {
    const payload = validation?.data && typeof validation.data === 'object' && !Array.isArray(validation.data)
        ? validation.data
        : validation;
    const statuses = [payload?.session?.status, payload?.status].map(normalizeStatus);

    // An explicit rejection wins over any conflicting success marker.
    if (statuses.some((status) => ['REJECTED', 'REAUTH_REQUIRED'].includes(status))) {
        return INCHILL_SESSION_VALIDATION_STATUS.REJECTED;
    }
    if (statuses.some((status) => ['VALID', 'CONNECTED', 'SUCCESS'].includes(status))) {
        return INCHILL_SESSION_VALIDATION_STATUS.VALID;
    }
    return INCHILL_SESSION_VALIDATION_STATUS.UNKNOWN;
};

module.exports = {
    INCHILL_SESSION_VALIDATION_STATUS,
    normalizeInchillSessionValidationStatus,
};
