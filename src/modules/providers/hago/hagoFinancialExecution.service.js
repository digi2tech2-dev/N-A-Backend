'use strict';

/**
 * Controlled Hago Diamond/Crystal execution.
 *
 * This module is intentionally not a generic provider abstraction. Hago's V2
 * financial outcome can be ambiguous after the request has been sent, so it
 * owns the compare-and-set claim, evidence snapshot, outcome classification,
 * reconciliation boundary, and the rules that forbid retry/refund for UNKNOWN.
 */

const { Order, ORDER_STATUS, HAGO_FINANCIAL_MUTATION_STATES } = require('../../orders/order.model');
const { Product } = require('../../products/product.model');
const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const { HagoProviderConnection, CONNECTION_STATUS } = require('./hagoProviderConnection.model');
const { HagoClient, HagoClientError, sanitizePayload } = require('./hago.client');
const { HagoAdapter } = require('../adapters/hago.adapter');
const { normalizeIdentity } = require('./hagoConnection.service');
const { BusinessRuleError } = require('../../../shared/errors/AppError');

const HAGO_SERVICE_BY_EXTERNAL_PRODUCT_ID = Object.freeze({
    HAGO_DIAMOND_AMOUNT: 'DIAMOND',
    HAGO_CRYSTAL_AMOUNT: 'CRYSTAL',
});

const HAGO_FINANCIAL_UNKNOWN_REASONS = Object.freeze({
    TRANSPORT_TIMEOUT: 'TRANSPORT_TIMEOUT',
    TRANSPORT_AMBIGUOUS: 'TRANSPORT_AMBIGUOUS',
    UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
    UPSTREAM_UNKNOWN: 'UPSTREAM_UNKNOWN',
    RECONCILIATION_UNRESOLVED: 'RECONCILIATION_UNRESOLVED',
});

const HAGO_TARGET_KEYS = new Set(['targetid', 'target_id', 'targetuid', 'target_uid', 'vid', 'hagoid', 'hago_id', 'playerid', 'player_id', 'target']);
const HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS = 3;
const HAGO_FINANCIAL_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

const isHagoFinancialEnabled = (serviceType, env = process.env) => (
    serviceType === 'DIAMOND'
        ? env.HAGO_DIAMOND_FULFILLMENT_ENABLED === 'true'
        : serviceType === 'CRYSTAL'
            ? env.HAGO_CRYSTAL_FULFILLMENT_ENABLED === 'true'
            : false
);

const serviceTypeFromProviderProduct = (providerProduct) => (
    HAGO_SERVICE_BY_EXTERNAL_PRODUCT_ID[String(providerProduct?.externalProductId ?? '').trim()] ?? null
);

const getTrustedTargetId = (values = {}, providerMapping = null) => {
    const candidates = [];
    for (const [key, value] of Object.entries(values || {})) {
        const mapped = providerMapping instanceof Map ? providerMapping.get(key) : providerMapping?.[key];
        if (HAGO_TARGET_KEYS.has(String(key).toLowerCase()) || HAGO_TARGET_KEYS.has(String(mapped ?? '').toLowerCase())) {
            const targetId = String(value ?? '').trim();
            if (targetId) candidates.push(targetId);
        }
    }
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
        throw new BusinessRuleError('A single Hago target ID is required for this product.', 'HAGO_TARGET_ID_REQUIRED');
    }
    return unique[0];
};

const isPositiveInteger = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

const classifyHagoMutation = (response) => {
    const safe = sanitizePayload(response?.data ?? response ?? {});
    const transaction = safe?.transaction;
    const transactionStatus = String(transaction?.status ?? '').toUpperCase();
    const upstreamStatus = String(transaction?.upstreamStatus ?? '').toUpperCase();
    const providerTransactionId = transaction?.id ? String(transaction.id) : null;
    const safeEvidence = {
        providerTransactionId,
        providerStatus: upstreamStatus || transactionStatus || null,
        providerCode: Number.isFinite(Number(transaction?.upstreamCode)) ? String(Number(transaction.upstreamCode)) : null,
    };

    if (transactionStatus === 'SUCCESS' && upstreamStatus === 'SUCCESS') {
        return { outcome: 'SUCCESS', ...safeEvidence };
    }
    if (transactionStatus === 'FAILED' && upstreamStatus === 'FAILED') {
        return { outcome: 'AUTHORITATIVE_FAILED', ...safeEvidence };
    }
    // The V2 adapter persists NOT_SENT only when its own documented safety
    // checks prevented the upstream send. That is safe to fail/refund.
    if (upstreamStatus === 'NOT_SENT') {
        return { outcome: 'AUTHORITATIVE_FAILED', ...safeEvidence, providerCode: safeEvidence.providerCode ?? 'NOT_SENT' };
    }
    if (transactionStatus === 'PENDING' || upstreamStatus === 'SEND_PENDING') {
        return { outcome: 'PENDING', ...safeEvidence };
    }
    return { outcome: 'UNKNOWN', ...safeEvidence, unknownReason: HAGO_FINANCIAL_UNKNOWN_REASONS.UPSTREAM_UNKNOWN };
};

const classifyHagoError = (error) => {
    const status = Number(error?.statusCode ?? error?.response?.status);
    const code = String(error?.code ?? '').toUpperCase();
    if (code === 'HAGO_UPSTREAM_TIMEOUT' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return HAGO_FINANCIAL_UNKNOWN_REASONS.TRANSPORT_TIMEOUT;
    }
    if ([502, 503, 504].includes(status) || ['ECONNRESET', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
        return status >= 500 ? HAGO_FINANCIAL_UNKNOWN_REASONS.UPSTREAM_UNAVAILABLE : HAGO_FINANCIAL_UNKNOWN_REASONS.TRANSPORT_AMBIGUOUS;
    }
    return HAGO_FINANCIAL_UNKNOWN_REASONS.TRANSPORT_AMBIGUOUS;
};

class HagoFinancialExecutionService {
    constructor({
        orderModel = Order,
        productModel = Product,
        providerModel = Provider,
        providerProductModel = ProviderProduct,
        connectionModel = HagoProviderConnection,
        client = new HagoClient(),
        adapterFactory = (provider) => new HagoAdapter(provider, { client }),
        refundFailedOrder = null,
        now = () => new Date(),
        env = process.env,
    } = {}) {
        this.Order = orderModel;
        this.Product = productModel;
        this.Provider = providerModel;
        this.ProviderProduct = providerProductModel;
        this.Connection = connectionModel;
        this.client = client;
        this.adapterFactory = adapterFactory;
        this.refundFailedOrder = refundFailedOrder;
        this.now = now;
        this.env = env;
    }

    async resolveProduct(product) {
        if (!product?.provider || !product?.providerProduct) return null;
        const [provider, providerProduct] = await Promise.all([
            this.Provider.findById(product.provider).select('slug isActive deletedAt'),
            this.ProviderProduct.findById(product.providerProduct).select('provider externalProductId rawPayload isActive'),
        ]);
        if (!provider || provider.deletedAt || provider.slug !== 'hago' || !providerProduct || String(providerProduct.provider) !== String(provider._id)) return null;
        const serviceType = serviceTypeFromProviderProduct(providerProduct);
        if (!serviceType) return null;
        return { provider, providerProduct, serviceType };
    }

    async prepareNewOrder({ product, quantity, customerInput }) {
        const resolved = await this.resolveProduct(product);
        if (!resolved) return null;
        const { provider, serviceType } = resolved;
        if (!isHagoFinancialEnabled(serviceType, this.env)) {
            throw new BusinessRuleError(`${serviceType === 'DIAMOND' ? 'Hago Diamond' : 'Hago Crystal'} checkout is not enabled.`, 'HAGO_FINANCIAL_CHECKOUT_NOT_ENABLED');
        }
        if (product.executionType !== 'automatic') {
            throw new BusinessRuleError(
                'Hago financial products must use automatic fulfillment.',
                'HAGO_AUTOMATIC_EXECUTION_REQUIRED'
            );
        }
        if (!isPositiveInteger(quantity)) {
            throw new BusinessRuleError('Hago transfer amount must be a positive whole number.', 'HAGO_INVALID_AMOUNT');
        }
        const targetId = getTrustedTargetId(customerInput?.values, product.providerMapping);
        const connection = await this.Connection.findOne({ provider: provider._id, isPrimary: true, enabled: true }).select('+connectionId');
        if (!connection?.connectionId) throw new BusinessRuleError('No enabled Hago connection is available.', 'HAGO_CONNECTION_UNAVAILABLE');
        if (connection.connectionStatus === CONNECTION_STATUS.REAUTH_REQUIRED) {
            throw new BusinessRuleError('The Hago connection requires reauthentication.', 'HAGO_SESSION_REAUTH_REQUIRED');
        }
        let identity;
        try {
            identity = normalizeIdentity(await this.client.verifyTarget(connection.connectionId, targetId), targetId);
        } catch (error) {
            if (error instanceof HagoClientError && [400, 404].includes(error.statusCode)) {
                throw new BusinessRuleError('The Hago target ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
            }
            throw new BusinessRuleError('Hago target validation is unavailable. Try again later.', 'HAGO_TARGET_VALIDATION_UNAVAILABLE');
        }
        if (!identity.uid && !identity.vid) {
            throw new BusinessRuleError('The Hago target ID is invalid or unavailable.', 'HAGO_INVALID_TARGET');
        }
        return { provider, serviceType, targetId, connectionRef: connection._id, providerAmount: Number(quantity) };
    }

    buildOrderSnapshot(prepared, orderId) {
        if (!prepared) return null;
        const service = prepared.serviceType.toLowerCase();
        return {
            serviceType: prepared.serviceType,
            requestedTargetId: prepared.targetId,
            providerAmount: prepared.providerAmount,
            connectionRef: prepared.connectionRef,
            providerMutationKey: `hago:${service}:${String(orderId)}`,
            mutationState: HAGO_FINANCIAL_MUTATION_STATES.READY,
        };
    }

    async _refund(order) {
        return this.refundFailedOrder ? this.refundFailedOrder(order) : false;
    }

    async _markUnknown(orderId, evidence = {}) {
        const now = this.now();
        const updated = await this.Order.findOneAndUpdate(
            { _id: orderId, 'hagoFinancial.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.READY, HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING] } },
            { $set: {
                status: ORDER_STATUS.MANUAL_REVIEW,
                'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN,
                'hagoFinancial.outcomeAt': now,
                'hagoFinancial.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoFinancial.providerStatus': evidence.providerStatus ?? null,
                'hagoFinancial.providerCode': evidence.providerCode ?? null,
                'hagoFinancial.unknownReason': evidence.unknownReason ?? HAGO_FINANCIAL_UNKNOWN_REASONS.UPSTREAM_UNKNOWN,
                lastCheckedAt: now,
            } },
            { new: true }
        );
        return updated ?? this.Order.findById(orderId);
    }

    async _settleSuccess(orderId, evidence) {
        const now = this.now();
        return this.Order.findOneAndUpdate(
            { _id: orderId, status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] }, 'hagoFinancial.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] } },
            { $set: {
                status: ORDER_STATUS.COMPLETED,
                providerStatus: 'SUCCESS',
                'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SUCCESS,
                'hagoFinancial.outcomeAt': now,
                'hagoFinancial.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoFinancial.providerStatus': evidence.providerStatus ?? 'SUCCESS',
                'hagoFinancial.providerCode': evidence.providerCode ?? null,
                lastCheckedAt: now,
            } },
            { new: true }
        );
    }

    async _settleAuthoritativeFailure(orderId, evidence) {
        const now = this.now();
        const order = await this.Order.findOneAndUpdate(
            { _id: orderId, status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] }, 'hagoFinancial.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] } },
            { $set: {
                status: ORDER_STATUS.FAILED,
                failedAt: now,
                providerStatus: 'FAILED',
                'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.FAILED,
                'hagoFinancial.outcomeAt': now,
                'hagoFinancial.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoFinancial.providerStatus': evidence.providerStatus ?? 'FAILED',
                'hagoFinancial.providerCode': evidence.providerCode ?? null,
                lastCheckedAt: now,
            } },
            { new: true }
        );
        if (!order) return this.Order.findById(orderId);
        await this._refund(order);
        return this.Order.findById(orderId);
    }

    async execute(orderId) {
        const order = await this.Order.findById(orderId).select('+hagoFinancial.connectionRef +hagoFinancial.providerMutationKey +hagoFinancial.providerTransactionId');
        if (!order?.hagoFinancial?.serviceType) return { handled: false };
        if (order.status !== ORDER_STATUS.PROCESSING || order.hagoFinancial.mutationState !== HAGO_FINANCIAL_MUTATION_STATES.READY) {
            return { handled: true, order, placed: false, refunded: false };
        }

        const now = this.now();
        const claimed = await this.Order.findOneAndUpdate(
            { _id: order._id, status: ORDER_STATUS.PROCESSING, 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.READY },
            { $set: { 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, 'hagoFinancial.claimedAt': now } },
            { new: true }
        ).select('+hagoFinancial.connectionRef +hagoFinancial.providerMutationKey +hagoFinancial.providerTransactionId');
        if (!claimed) return { handled: true, order: await this.Order.findById(orderId), placed: false, refunded: false };

        const sent = await this.Order.findOneAndUpdate(
            { _id: claimed._id, 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.CLAIMED },
            { $set: { 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SENT, 'hagoFinancial.sentAt': this.now() } },
            { new: true }
        ).select('+hagoFinancial.connectionRef +hagoFinancial.providerMutationKey +hagoFinancial.providerTransactionId');
        if (!sent) return { handled: true, order: await this.Order.findById(orderId), placed: false, refunded: false };

        const connection = await this.Connection.findById(sent.hagoFinancial.connectionRef).select('+connectionId');
        const product = await this.Product.findById(sent.productId);
        const resolved = await this.resolveProduct(product);
        if (!connection?.connectionId || !resolved || !isHagoFinancialEnabled(sent.hagoFinancial.serviceType, this.env)) {
            const failed = await this._settleAuthoritativeFailure(orderId, { providerStatus: 'NOT_SENT', providerCode: 'PRE_SEND_CONFIGURATION' });
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }

        let outcome;
        try {
            const adapter = this.adapterFactory(resolved.provider);
            const response = await adapter.executeControlledRecharge({
                serviceType: sent.hagoFinancial.serviceType,
                connectionId: connection.connectionId,
                targetId: sent.hagoFinancial.requestedTargetId,
                amount: sent.hagoFinancial.providerAmount,
                idempotencyKey: sent.hagoFinancial.providerMutationKey,
            });
            outcome = classifyHagoMutation(response);
        } catch (error) {
            outcome = { outcome: 'UNKNOWN', unknownReason: classifyHagoError(error) };
        }

        if (outcome.outcome === 'SUCCESS') {
            return { handled: true, order: await this._settleSuccess(orderId, outcome), placed: true, refunded: false };
        }
        if (outcome.outcome === 'AUTHORITATIVE_FAILED') {
            const failed = await this._settleAuthoritativeFailure(orderId, outcome);
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }
        if (outcome.outcome === 'PENDING') {
            const pending = await this.Order.findOneAndUpdate(
                { _id: orderId, 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SENT },
                { $set: { 'hagoFinancial.mutationState': HAGO_FINANCIAL_MUTATION_STATES.PENDING, 'hagoFinancial.providerTransactionId': outcome.providerTransactionId ?? null, 'hagoFinancial.providerStatus': outcome.providerStatus ?? 'SEND_PENDING', 'hagoFinancial.providerCode': outcome.providerCode ?? null, lastCheckedAt: this.now() } },
                { new: true }
            );
            return { handled: true, order: pending, placed: true, refunded: false };
        }
        return { handled: true, order: await this._markUnknown(orderId, outcome), placed: false, refunded: false };
    }

    async reconcile(orderId) {
        const order = await this.Order.findById(orderId).select('+hagoFinancial.connectionRef +hagoFinancial.providerMutationKey +hagoFinancial.providerTransactionId');
        if (!order?.hagoFinancial?.serviceType || ![HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, HAGO_FINANCIAL_MUTATION_STATES.PENDING].includes(order.hagoFinancial.mutationState)) {
            throw new BusinessRuleError('This order has no unresolved Hago financial outcome.', 'HAGO_RECONCILIATION_NOT_REQUIRED');
        }
        const connection = await this.Connection.findById(order.hagoFinancial.connectionRef).select('+connectionId');
        if (!connection?.connectionId || !order.hagoFinancial.providerTransactionId) {
            await this.Order.findByIdAndUpdate(order._id, { $set: { 'hagoFinancial.lastReconciledAt': this.now(), 'hagoFinancial.unknownReason': HAGO_FINANCIAL_UNKNOWN_REASONS.RECONCILIATION_UNRESOLVED }, $inc: { 'hagoFinancial.reconciliationAttempts': 1 } });
            return { order: await this.Order.findById(orderId), outcome: 'UNRESOLVED' };
        }
        let latest;
        try {
            latest = await this.client.lookupTransaction(connection.connectionId, order.hagoFinancial.providerTransactionId);
            // The documented endpoint is read-only/manual-review-only. Call it
            // for safe diagnostic evidence but never infer settlement from its
            // history payload alone.
            await this.client.reconcileTransaction(connection.connectionId, order.hagoFinancial.providerTransactionId);
        } catch (_) {
            await this.Order.findByIdAndUpdate(order._id, { $set: { 'hagoFinancial.lastReconciledAt': this.now(), 'hagoFinancial.unknownReason': HAGO_FINANCIAL_UNKNOWN_REASONS.RECONCILIATION_UNRESOLVED }, $inc: { 'hagoFinancial.reconciliationAttempts': 1 } });
            return { order: await this.Order.findById(orderId), outcome: 'UNRESOLVED' };
        }
        const outcome = classifyHagoMutation({ data: { transaction: latest } });
        if (outcome.outcome === 'SUCCESS') return { order: await this._settleSuccess(orderId, outcome), outcome: 'SUCCESS' };
        if (outcome.outcome === 'AUTHORITATIVE_FAILED') return { order: await this._settleAuthoritativeFailure(orderId, outcome), outcome: 'FAILED' };
        await this.Order.findByIdAndUpdate(order._id, { $set: { 'hagoFinancial.lastReconciledAt': this.now(), 'hagoFinancial.unknownReason': HAGO_FINANCIAL_UNKNOWN_REASONS.RECONCILIATION_UNRESOLVED }, $inc: { 'hagoFinancial.reconciliationAttempts': 1 } });
        return { order: await this.Order.findById(orderId), outcome: 'UNRESOLVED' };
    }

    async reconcileScheduled({ limit = 20 } = {}) {
        const now = this.now();
        const dueBefore = new Date(now.getTime() - HAGO_FINANCIAL_RECONCILIATION_INTERVAL_MS);
        const orders = await this.Order.find({
            providerCode: 'hago',
            status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] },
            'hagoFinancial.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] },
            'hagoFinancial.providerTransactionId': { $ne: null },
            'hagoFinancial.reconciliationAttempts': { $lt: HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS },
            $or: [
                { 'hagoFinancial.lastReconciledAt': null },
                { 'hagoFinancial.lastReconciledAt': { $lte: dueBefore } },
            ],
        }).sort({ 'hagoFinancial.lastReconciledAt': 1 }).limit(Math.max(1, Math.min(Number(limit) || 20, 50))).select('_id');

        const results = [];
        for (const order of orders) {
            try {
                results.push(await this.reconcile(order._id));
            } catch (_) {
                // The reconciliation method itself keeps unresolved records in
                // a safe no-refund state. One record must not stop the queue.
            }
        }
        return results;
    }

    async markUnexpectedExecutionError(orderId) {
        return this._markUnknown(orderId, {
            unknownReason: HAGO_FINANCIAL_UNKNOWN_REASONS.TRANSPORT_AMBIGUOUS,
        });
    }

    isRefundBlocked(order) {
        return Boolean(order?.hagoFinancial?.serviceType)
            && [HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN].includes(order.hagoFinancial.mutationState);
    }
}

module.exports = {
    HagoFinancialExecutionService,
    HAGO_SERVICE_BY_EXTERNAL_PRODUCT_ID,
    HAGO_FINANCIAL_UNKNOWN_REASONS,
    HAGO_FINANCIAL_MUTATION_STATES,
    HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS,
    HAGO_FINANCIAL_RECONCILIATION_INTERVAL_MS,
    isHagoFinancialEnabled,
    serviceTypeFromProviderProduct,
    getTrustedTargetId,
    classifyHagoMutation,
    classifyHagoError,
};
