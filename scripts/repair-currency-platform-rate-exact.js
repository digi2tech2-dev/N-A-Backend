'use strict';

/**
 * One-time repair for Currency.platformRateExact inconsistencies.
 *
 * platformRate is the sole economic source of truth. This script derives the
 * canonical exact string from it and never changes platformRate or any order,
 * wallet transaction, or historical snapshot.
 *
 * Usage (safe by default):
 *   node scripts/repair-currency-platform-rate-exact.js
 *   node scripts/repair-currency-platform-rate-exact.js --apply
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { Currency } = require('../src/modules/currency/currency.model');
const { legacyPlatformRateToExact } = require('../src/shared/utils/exactLedgerMoney');

const APPLY_FLAG = '--apply';

const parseArgs = (argv = process.argv.slice(2)) => {
    const unknown = argv.filter((arg) => arg !== APPLY_FLAG);
    if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}. Only --apply is supported.`);
    return { apply: argv.includes(APPLY_FLAG) };
};

const buildCurrencyRateExactRepair = (currency) => {
    const expectedPlatformRateExact = legacyPlatformRateToExact(currency.platformRate);
    const currentPlatformRateExact = currency.platformRateExact ?? null;
    return {
        code: currency.code,
        platformRate: currency.platformRate,
        platformRateExact: currentPlatformRateExact,
        expectedPlatformRateExact,
        mismatched: currentPlatformRateExact !== expectedPlatformRateExact,
    };
};

const runRepair = async ({ apply = false } = {}) => {
    const currencies = await Currency.find({})
        .select('code platformRate +platformRateExact')
        .sort({ code: 1 });
    const repairs = currencies.map((currency) => ({
        currencyId: currency._id,
        ...buildCurrencyRateExactRepair(currency),
    }));

    for (const repair of repairs) {
        console.log(JSON.stringify({
            status: repair.mismatched ? 'MISMATCH' : 'MATCH',
            code: repair.code,
            platformRate: repair.platformRate,
            platformRateExact: repair.platformRateExact,
            expectedPlatformRateExact: repair.expectedPlatformRateExact,
        }));
    }

    const mismatches = repairs.filter((repair) => repair.mismatched);
    let updated = 0;
    if (apply && mismatches.length) {
        // Include the authoritative rate in each predicate so a concurrent
        // admin rate update cannot be overwritten by this one-time repair.
        const operations = mismatches.map((repair) => ({
            updateOne: {
                filter: {
                    _id: repair.currencyId,
                    platformRate: repair.platformRate,
                    platformRateExact: { $ne: repair.expectedPlatformRateExact },
                },
                update: { $set: { platformRateExact: repair.expectedPlatformRateExact } },
            },
        }));
        const result = await Currency.collection.bulkWrite(operations, { ordered: true });
        updated = result.modifiedCount;
    }

    const summary = { mode: apply ? 'APPLY' : 'DRY-RUN', scanned: repairs.length, mismatches: mismatches.length, updated };
    console.log(JSON.stringify(summary));
    return { repairs, summary };
};

const main = async () => {
    const options = parseArgs();
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    await mongoose.connect(process.env.MONGO_URI);
    try {
        await runRepair(options);
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`Currency rate-exact repair stopped: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, buildCurrencyRateExactRepair, runRepair };
