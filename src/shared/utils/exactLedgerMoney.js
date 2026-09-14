'use strict';

/**
 * Phase-1 exact customer-ledger primitives.
 *
 * These helpers are deliberately additive.  They must not be used as the
 * authority for a production debit/refund until the later ledger cut-over.
 * Exact customer amounts are represented as signed base-10 integer strings at
 * a fixed scale.  Decimal API values are strings as well; neither format ever
 * passes through JavaScript Number arithmetic.
 */

const Decimal = require('decimal.js');

const LEDGER_SCALE = 56;
const PRICE_FRACTION_DIGITS = 50;
const PLATFORM_RATE_FRACTION_DIGITS = 6;
const MAX_PRICE_WHOLE_DIGITS = 60;
const MAX_PLATFORM_RATE_WHOLE_DIGITS = 60;
const MAX_LEDGER_WHOLE_DIGITS = 129; // 60 price + 9 quantity + 60 rate digits.
const MAX_QUANTITY = 999999999;
const MAX_LEDGER_UNITS_DIGITS = MAX_LEDGER_WHOLE_DIGITS + LEDGER_SCALE;

const UNIT_SCALE = 10n ** BigInt(LEDGER_SCALE);
// Input accepts leading zeros so it can normalize them; persisted output is
// canonical and never retains them.
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;
const UNITS_PATTERN = /^-?\d+$/;

class ExactLedgerMoneyError extends Error {
    constructor(message, code = 'EXACT_LEDGER_MONEY_INVALID') {
        super(message);
        this.name = 'ExactLedgerMoneyError';
        this.code = code;
    }
}

const assertString = (value, label) => {
    if (typeof value !== 'string') {
        throw new ExactLedgerMoneyError(`${label} must be a decimal string.`, 'EXACT_LEDGER_STRING_REQUIRED');
    }
    return value.trim();
};

const normalizeDecimalString = (value, {
    allowNegative = true,
    maxFractionDigits = LEDGER_SCALE,
    maxWholeDigits = MAX_LEDGER_WHOLE_DIGITS,
    label = 'Amount',
} = {}) => {
    const raw = assertString(value, label);
    if (!raw || !DECIMAL_PATTERN.test(raw)) {
        throw new ExactLedgerMoneyError(`${label} must be a plain decimal string without exponent notation.`, 'EXACT_LEDGER_DECIMAL_INVALID');
    }
    if (!allowNegative && raw.startsWith('-')) {
        throw new ExactLedgerMoneyError(`${label} cannot be negative.`, 'EXACT_LEDGER_NEGATIVE_NOT_ALLOWED');
    }

    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    let [whole, fraction = ''] = unsigned.split('.');
    whole = whole.replace(/^0+(?=\d)/, '') || '0';

    if (whole.length > maxWholeDigits) {
        throw new ExactLedgerMoneyError(`${label} exceeds the supported whole-digit limit.`, 'EXACT_LEDGER_WHOLE_DIGITS_EXCEEDED');
    }
    // Validate the submitted plain-decimal scale before canonicalizing away
    // insignificant trailing zeros. A scale-57 input must never silently be
    // accepted as a scale-56 value.
    if (fraction.length > maxFractionDigits) {
        throw new ExactLedgerMoneyError(`${label} exceeds the supported fractional precision.`, 'EXACT_LEDGER_SCALE_EXCEEDED');
    }
    fraction = fraction.replace(/0+$/, '');

    const isZero = whole === '0' && !fraction;
    return `${negative && !isZero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

const normalizeUnitsString = (value, { label = 'Ledger units' } = {}) => {
    const raw = assertString(value, label);
    if (!raw || !UNITS_PATTERN.test(raw)) {
        throw new ExactLedgerMoneyError(`${label} must be a canonical integer string.`, 'EXACT_LEDGER_UNITS_INVALID');
    }
    const negative = raw.startsWith('-');
    const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, '') || '0';
    if (digits.length > MAX_LEDGER_UNITS_DIGITS) {
        throw new ExactLedgerMoneyError(`${label} exceeds the supported unit length.`, 'EXACT_LEDGER_UNITS_OVERFLOW');
    }
    return negative && digits !== '0' ? `-${digits}` : digits;
};

/**
 * Mongoose String paths normally coerce numbers before validators run. Exact
 * money must enter the schema as a string so that no source value crosses a
 * JavaScript Number boundary. This is intended for field-level setters.
 */
const requireExactStringInput = (value, { label = 'Exact ledger value' } = {}) => {
    if (value == null) return value;
    if (typeof value !== 'string') {
        throw new ExactLedgerMoneyError(`${label} must be supplied as a string.`, 'EXACT_LEDGER_STRING_REQUIRED');
    }
    return value;
};

/** Validates a canonical persisted unit string with field-specific sign rules. */
const assertCanonicalUnits = (value, {
    allowNegative = true,
    allowZero = true,
    label = 'Ledger units',
} = {}) => {
    const normalized = normalizeUnitsString(value, { label });
    if (normalized !== value) {
        throw new ExactLedgerMoneyError(`${label} must be a canonical integer string.`, 'EXACT_LEDGER_UNITS_NON_CANONICAL');
    }
    const units = BigInt(normalized);
    if (!allowNegative && units < 0n) {
        throw new ExactLedgerMoneyError(`${label} cannot be negative.`, 'EXACT_LEDGER_NEGATIVE_NOT_ALLOWED');
    }
    if (!allowZero && units === 0n) {
        throw new ExactLedgerMoneyError(`${label} must be positive.`, 'EXACT_LEDGER_NOT_POSITIVE');
    }
    return normalized;
};

const decimalStringToUnits = (value, options = {}) => {
    const normalized = normalizeDecimalString(value, options);
    const negative = normalized.startsWith('-');
    const unsigned = negative ? normalized.slice(1) : normalized;
    const [whole, fraction = ''] = unsigned.split('.');
    const paddedFraction = `${fraction}${'0'.repeat(LEDGER_SCALE)}`.slice(0, LEDGER_SCALE);
    const units = BigInt(whole) * UNIT_SCALE + BigInt(paddedFraction || '0');
    return normalizeUnitsString((negative ? -units : units).toString());
};

const unitsToDecimalString = (value) => {
    const normalized = normalizeUnitsString(value);
    const negative = normalized.startsWith('-');
    const units = BigInt(negative ? normalized.slice(1) : normalized);
    const whole = units / UNIT_SCALE;
    const fraction = (units % UNIT_SCALE).toString().padStart(LEDGER_SCALE, '0').replace(/0+$/, '');
    return `${negative && units !== 0n ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
};

const addUnits = (left, right) => normalizeUnitsString((BigInt(normalizeUnitsString(left)) + BigInt(normalizeUnitsString(right))).toString());
const subtractUnits = (left, right) => normalizeUnitsString((BigInt(normalizeUnitsString(left)) - BigInt(normalizeUnitsString(right))).toString());
const compareUnits = (left, right) => {
    const a = BigInt(normalizeUnitsString(left));
    const b = BigInt(normalizeUnitsString(right));
    return a === b ? 0 : (a > b ? 1 : -1);
};
const isPositiveUnits = (value) => BigInt(normalizeUnitsString(value)) > 0n;
const isZeroUnits = (value) => BigInt(normalizeUnitsString(value)) === 0n;

/**
 * Converts a current cent-based BSON Number to the exact compatibility value.
 * This intentionally applies the existing 2dp business rule, rather than
 * serializing binary floating-point dust such as 10.249999999999998.
 */
const legacyCentMoneyToUnits = (value, { label = 'Legacy money' } = {}) => {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new ExactLedgerMoneyError(`${label} must be a finite legacy monetary value.`, 'EXACT_LEDGER_LEGACY_NUMBER_INVALID');
    }
    let decimal;
    try { decimal = new Decimal(value); } catch (_) {
        throw new ExactLedgerMoneyError(`${label} must be a finite legacy monetary value.`, 'EXACT_LEDGER_LEGACY_NUMBER_INVALID');
    }
    if (!decimal.isFinite()) {
        throw new ExactLedgerMoneyError(`${label} must be a finite legacy monetary value.`, 'EXACT_LEDGER_LEGACY_NUMBER_INVALID');
    }
    const canonicalCents = decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    return decimalStringToUnits(canonicalCents, { label, maxWholeDigits: MAX_LEDGER_WHOLE_DIGITS });
};

const legacyMoneyToUnits = legacyCentMoneyToUnits;

const normalizePlatformRateExact = (value) => {
    const normalized = normalizeDecimalString(value, {
        allowNegative: false,
        maxFractionDigits: PLATFORM_RATE_FRACTION_DIGITS,
        maxWholeDigits: MAX_PLATFORM_RATE_WHOLE_DIGITS,
        label: 'Platform rate',
    });
    if (normalized === '0') {
        throw new ExactLedgerMoneyError('Platform rate must be positive.', 'EXACT_LEDGER_RATE_NOT_POSITIVE');
    }
    return normalized;
};

/** Preserves the existing persisted six-decimal platform-rate semantics. */
const legacyPlatformRateToExact = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new ExactLedgerMoneyError('Legacy platform rate must be a positive finite number.', 'EXACT_LEDGER_LEGACY_RATE_INVALID');
    }
    const canonicalRate = new Decimal(value)
        .toDecimalPlaces(PLATFORM_RATE_FRACTION_DIGITS, Decimal.ROUND_HALF_UP)
        .toFixed(PLATFORM_RATE_FRACTION_DIGITS);
    return normalizePlatformRateExact(canonicalRate);
};

const assertSupportedQuantity = (value) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_QUANTITY) {
        throw new ExactLedgerMoneyError(`Quantity must be an integer between 1 and ${MAX_QUANTITY}.`, 'EXACT_LEDGER_QUANTITY_OUT_OF_RANGE');
    }
    return value;
};

module.exports = {
    LEDGER_SCALE,
    PRICE_FRACTION_DIGITS,
    PLATFORM_RATE_FRACTION_DIGITS,
    MAX_PRICE_WHOLE_DIGITS,
    MAX_PLATFORM_RATE_WHOLE_DIGITS,
    MAX_LEDGER_WHOLE_DIGITS,
    MAX_QUANTITY,
    MAX_LEDGER_UNITS_DIGITS,
    ExactLedgerMoneyError,
    normalizeDecimalString,
    normalizeUnitsString,
    requireExactStringInput,
    assertCanonicalUnits,
    decimalStringToUnits,
    unitsToDecimalString,
    addUnits,
    subtractUnits,
    compareUnits,
    isPositiveUnits,
    isZeroUnits,
    legacyCentMoneyToUnits,
    legacyMoneyToUnits,
    normalizePlatformRateExact,
    legacyPlatformRateToExact,
    assertSupportedQuantity,
};
