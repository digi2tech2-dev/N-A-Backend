'use strict';

const Decimal = require('decimal.js');
const {
    readExactCompatibleLedger,
    serializeExactCompatibleLedger,
} = require('./exactLedgerCompatibility');
const {
    addUnits,
    subtractUnits,
    compareUnits,
    unitsToDecimalString,
} = require('./exactLedgerMoney');

const toDecimal = (value) => {
    try {
        const decimal = new Decimal(value ?? 0);
        return decimal.isFinite() ? decimal : new Decimal(0);
    } catch (_) {
        return new Decimal(0);
    }
};

const roundMoneyDecimal = (value) => toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

const toMoneyNumber = (value) => roundMoneyDecimal(value).toNumber();

const buildWalletSummary = (source = {}) => {
    const walletBalance = roundMoneyDecimal(source.walletBalance ?? source.balance ?? source.coins ?? 0);
    const creditLimit = Decimal.max(0, roundMoneyDecimal(source.creditLimit ?? 0));
    const creditUsed = walletBalance.isNegative()
        ? Decimal.min(walletBalance.abs(), creditLimit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : new Decimal(0);
    const rawAvailableBalance = walletBalance.plus(creditLimit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const availableBalance = Decimal.max(0, rawAvailableBalance).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const availableCredit = Decimal.max(0, creditLimit.minus(creditUsed)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    return {
        walletBalance: walletBalance.toNumber(),
        creditLimit: creditLimit.toNumber(),
        creditUsed: creditUsed.toNumber(),
        availableCredit: availableCredit.toNumber(),
        availableBalance: availableBalance.toNumber(),
        rawAvailableBalance: rawAvailableBalance.toNumber(),
        currency: String(source.currency || 'USD').toUpperCase(),
    };
};

const buildPublicWalletSummary = (source = {}) => {
    const {
        rawAvailableBalance: _rawAvailableBalance,
        ...summary
    } = buildWalletSummary(source);
    return summary;
};

const buildExactPublicWalletSummary = (source = {}) => {
    const compatible = readExactCompatibleLedger(source);
    const { exactLedger } = serializeExactCompatibleLedger(source);
    const { walletBalanceUnits, creditLimitUnits, creditUsedUnits } = compatible.units;
    const rawAvailableBalance = addUnits(walletBalanceUnits, creditLimitUnits);
    const availableBalance = compareUnits(rawAvailableBalance, '0') < 0 ? '0' : rawAvailableBalance;
    const remainingCredit = subtractUnits(creditLimitUnits, creditUsedUnits);
    const availableCredit = compareUnits(remainingCredit, '0') < 0 ? '0' : remainingCredit;

    return {
        walletBalance: exactLedger.walletBalance,
        creditLimit: exactLedger.creditLimit,
        creditUsed: exactLedger.creditUsed,
        availableCredit: unitsToDecimalString(availableCredit),
        availableBalance: unitsToDecimalString(availableBalance),
        currency: String(source.currency || 'USD').toUpperCase(),
    };
};

module.exports = {
    buildWalletSummary,
    buildPublicWalletSummary,
    buildExactPublicWalletSummary,
    roundMoneyDecimal,
    toMoneyNumber,
};
