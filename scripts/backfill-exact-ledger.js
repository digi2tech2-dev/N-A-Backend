'use strict';

/**
 * Phase-1 exact-ledger backfill. This script is never imported by runtime
 * code and defaults to dry-run. Run it only during an approved maintenance
 * window, after a separate reviewed dry-run report.
 *
 * Usage:
 *   node scripts/backfill-exact-ledger.js
 *   node scripts/backfill-exact-ledger.js --write --batch-size=250
 *   node scripts/backfill-exact-ledger.js --write --collection=users --resume-after=<ObjectId>
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { User } = require('../src/modules/users/user.model');
const { WalletTransaction } = require('../src/modules/wallet/walletTransaction.model');
const { Order } = require('../src/modules/orders/order.model');
const { Currency } = require('../src/modules/currency/currency.model');
const {
    legacyCentMoneyToUnits,
    legacyPlatformRateToExact,
    normalizePlatformRateExact,
    normalizeUnitsString,
} = require('../src/shared/utils/exactLedgerMoney');

const WRITE_FLAG = '--write';
const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;
const COLLECTION_NAMES = new Set(['users', 'wallet-transactions', 'orders', 'currencies']);

const parseArgs = (argv = process.argv.slice(2)) => {
    const batchArg = argv.find((arg) => arg.startsWith('--batch-size='));
    const resumeArg = argv.find((arg) => arg.startsWith('--resume-after='));
    const collectionArg = argv.find((arg) => arg.startsWith('--collection='));
    const parsedBatch = Number(batchArg?.split('=')[1] ?? DEFAULT_BATCH_SIZE);
    if (!Number.isSafeInteger(parsedBatch) || parsedBatch < 1 || parsedBatch > MAX_BATCH_SIZE) {
        throw new Error(`--batch-size must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
    }
    const resumeAfter = resumeArg?.split('=')[1] || null;
    const collection = collectionArg?.split('=')[1] || null;
    if (collection && !COLLECTION_NAMES.has(collection)) {
        throw new Error(`--collection must be one of: ${[...COLLECTION_NAMES].join(', ')}.`);
    }
    if (resumeAfter && !mongoose.Types.ObjectId.isValid(resumeAfter)) {
        throw new Error('--resume-after must be a valid ObjectId.');
    }
    if (resumeAfter && !collection) {
        throw new Error('--resume-after requires --collection so a cursor cannot skip another collection.');
    }
    return { write: argv.includes(WRITE_FLAG), batchSize: parsedBatch, resumeAfter, collection };
};

const assertExistingOrSet = ({ doc, field, expected, update }) => {
    const existing = doc[field];
    if (existing == null) {
        update[field] = expected;
        return;
    }
    let normalized;
    try { normalized = normalizeUnitsString(existing); } catch (_) {
        throw new Error(`${doc.constructor.modelName} ${doc._id}: ${field} is invalid or inconsistent with its legacy source.`);
    }
    if (normalized !== existing || existing !== expected) {
        throw new Error(`${doc.constructor.modelName} ${doc._id}: ${field} is inconsistent with its legacy source.`);
    }
};

const buildUserUpdate = (doc) => {
    const update = {};
    assertExistingOrSet({ doc, field: 'walletBalanceUnits', expected: legacyCentMoneyToUnits(doc.walletBalance, { label: 'walletBalance' }), update });
    assertExistingOrSet({ doc, field: 'creditLimitUnits', expected: legacyCentMoneyToUnits(doc.creditLimit, { label: 'creditLimit' }), update });
    assertExistingOrSet({ doc, field: 'creditUsedUnits', expected: legacyCentMoneyToUnits(doc.creditUsed, { label: 'creditUsed' }), update });
    if (doc.walletLedgerVersion == null) update.walletLedgerVersion = 0;
    else if (!Number.isSafeInteger(doc.walletLedgerVersion) || doc.walletLedgerVersion < 0) {
        throw new Error(`User ${doc._id}: walletLedgerVersion is invalid.`);
    }
    return update;
};

const buildWalletTransactionUpdate = (doc) => {
    const update = {};
    assertExistingOrSet({ doc, field: 'amountUnits', expected: legacyCentMoneyToUnits(doc.amount, { label: 'amount' }), update });
    assertExistingOrSet({ doc, field: 'balanceBeforeUnits', expected: legacyCentMoneyToUnits(doc.balanceBefore, { label: 'balanceBefore' }), update });
    assertExistingOrSet({ doc, field: 'balanceAfterUnits', expected: legacyCentMoneyToUnits(doc.balanceAfter, { label: 'balanceAfter' }), update });
    return update;
};

const buildOrderUpdate = (doc) => {
    const update = {};
    const chargedSource = doc.chargedAmount ?? doc.walletDeducted ?? 0;
    const deductedSource = doc.walletDeducted ?? doc.chargedAmount ?? 0;
    const creditSource = doc.creditUsedAmount ?? '0';
    assertExistingOrSet({ doc, field: 'chargedAmountUnits', expected: legacyCentMoneyToUnits(chargedSource, { label: 'chargedAmount' }), update });
    assertExistingOrSet({ doc, field: 'walletDeductedUnits', expected: legacyCentMoneyToUnits(deductedSource, { label: 'walletDeducted' }), update });
    assertExistingOrSet({ doc, field: 'creditUsedAmountUnits', expected: legacyCentMoneyToUnits(creditSource, { label: 'creditUsedAmount' }), update });
    return update;
};

const buildCurrencyUpdate = (doc) => {
    const expected = legacyPlatformRateToExact(doc.platformRate);
    if (doc.platformRateExact == null) return { platformRateExact: expected };
    let normalized;
    try { normalized = normalizePlatformRateExact(doc.platformRateExact); } catch (_) {
        throw new Error(`Currency ${doc._id}: platformRateExact is invalid or inconsistent with platformRate.`);
    }
    if (normalized !== doc.platformRateExact || doc.platformRateExact !== expected) {
        throw new Error(`Currency ${doc._id}: platformRateExact is inconsistent with platformRate.`);
    }
    return {};
};

const runCollection = async ({ model, select, buildUpdate, batchSize, resumeAfter, write }) => {
    const counts = { scanned: 0, wouldUpdate: 0, updated: 0, skipped: 0 };
    let cursor = resumeAfter ? new mongoose.Types.ObjectId(resumeAfter) : null;
    while (true) {
        const filter = cursor ? { _id: { $gt: cursor } } : {};
        const docs = await model.find(filter).select(select).sort({ _id: 1 }).limit(batchSize);
        if (!docs.length) break;

        const operations = [];
        for (const doc of docs) {
            counts.scanned += 1;
            const update = buildUpdate(doc);
            if (Object.keys(update).length) {
                counts.wouldUpdate += 1;
                operations.push({ updateOne: { filter: { _id: doc._id }, update: { $set: update } } });
            } else {
                counts.skipped += 1;
            }
        }
        if (write && operations.length) {
            const result = await model.bulkWrite(operations, { ordered: true });
            counts.updated += result.modifiedCount;
        }
        cursor = docs[docs.length - 1]._id;
    }
    return counts;
};

const main = async () => {
    const options = parseArgs();
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    await mongoose.connect(process.env.MONGO_URI);
    try {
        console.log(`Exact-ledger backfill mode: ${options.write ? 'WRITE' : 'DRY-RUN'} (batch ${options.batchSize})`);
        const collections = {
            users: { model: User, select: '+walletBalanceUnits +creditLimitUnits +creditUsedUnits walletBalance creditLimit creditUsed walletLedgerVersion', buildUpdate: buildUserUpdate },
            'wallet-transactions': { model: WalletTransaction, select: '+amountUnits +balanceBeforeUnits +balanceAfterUnits amount balanceBefore balanceAfter', buildUpdate: buildWalletTransactionUpdate },
            orders: { model: Order, select: '+chargedAmountUnits +walletDeductedUnits +creditUsedAmountUnits chargedAmount walletDeducted creditUsedAmount', buildUpdate: buildOrderUpdate },
            currencies: { model: Currency, select: '+platformRateExact platformRate', buildUpdate: buildCurrencyUpdate },
        };
        const selected = options.collection ? [options.collection] : Object.keys(collections);
        const results = {};
        for (const name of selected) {
            results[name] = await runCollection({ ...collections[name], ...options });
        }
        console.log(JSON.stringify(results, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`Exact-ledger backfill stopped: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArgs,
    buildUserUpdate,
    buildWalletTransactionUpdate,
    buildOrderUpdate,
    buildCurrencyUpdate,
};
