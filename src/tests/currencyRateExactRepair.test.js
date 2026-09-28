'use strict';

const {
    parseArgs,
    buildCurrencyRateExactRepair,
} = require('../../scripts/repair-currency-platform-rate-exact');

describe('currency platformRateExact repair script', () => {
    test('defaults to dry-run and requires the explicit --apply mutation flag', () => {
        expect(parseArgs([])).toEqual({ apply: false });
        expect(parseArgs(['--apply'])).toEqual({ apply: true });
        expect(() => parseArgs(['--write'])).toThrow('Only --apply is supported');
    });

    test('reports stale exact values and derives the repair only from platformRate', () => {
        expect(buildCurrencyRateExactRepair({
            code: 'EGP', platformRate: 55, platformRateExact: '53.3',
        })).toEqual({
            code: 'EGP',
            platformRate: 55,
            platformRateExact: '53.3',
            expectedPlatformRateExact: '55',
            mismatched: true,
        });
    });

    test('is idempotent once the exact field matches the canonical platform rate', () => {
        expect(buildCurrencyRateExactRepair({
            code: 'EGP', platformRate: 55, platformRateExact: '55',
        }).mismatched).toBe(false);
    });
});
