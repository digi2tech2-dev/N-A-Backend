'use strict';

/*
 * Controlled Hago Nobility execution.
 *
 * Nobility is intentionally separate from Diamond/Crystal: its price and
 * target are bound to a short-lived readiness quote. It shares the same
 * compare-and-set and no-refund-on-ambiguity rules after the mutation leaves
 * N&A, but never accepts a browser-supplied price, level, or operation.
 */

const { Order, ORDER_STATUS, HAGO_FINANCIAL_MUTATION_STATES } = require('../../orders/order.model');
const { Product, PRICING_STRATEGIES } = require('../../products/product.model');
const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const { User } = require('../../users/user.model');
const { HagoProviderConnection } = require('./hagoProviderConnection.model');
const { HagoClient } = require('./hago.client');
const { HagoAdapter } = require('../adapters/hago.adapter');
const { HagoNobilityCommerceService, deriveNobilityType } = require('./hagoNobilityCommerce.service');
const {
    classifyHagoMutation,
    classifyHagoError,
    HAGO_FINANCIAL_UNKNOWN_REASONS,
    HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS,
    HAGO_FINANCIAL_RECONCILIATION_INTERVAL_MS,
} = require('./hagoFinancialExecution.service');
const { BusinessRuleError } = require('../../../shared/errors/AppError');

const isHagoNobilityEnabled = (env = process.env) => env.HAGO_NOBILITY_FULFILLMENT_ENABLED === 'true';

class HagoNobilityExecutionService {
    constructor({
        orderModel = Order,
        productModel = Product,
        providerModel = Provider,
        providerProductModel = ProviderProduct,
        userModel = User,
        connectionModel = HagoProviderConnection,
        client = new HagoClient(),
        commerceService = null,
        adapterFactory = (provider) => new HagoAdapter(provider, { client }),
        refundFailedOrder = null,
        now = () => new Date(),
        env = process.env,
    } = {}) {
        this.Order = orderModel;
        this.Product = productModel;
        this.Provider = providerModel;
        this.ProviderProduct = providerProductModel;
        this.User = userModel;
        this.Connection = connectionModel;
        this.client = client;
        this.commerce = commerceService ?? new HagoNobilityCommerceService({ client });
        this.adapterFactory = adapterFactory;
        this.refundFailedOrder = refundFailedOrder;
        this.now = now;
        this.env = env;
    }

    async prepareNewOrder({ userId, product, quantity, quoteRef, targetId }) {
        if (!isHagoNobilityEnabled(this.env)) {
            throw new BusinessRuleError('Hago Nobility checkout is not enabled.', 'HAGO_NOBILITY_CHECKOUT_NOT_ENABLED');
        }
        if (product.executionType !== 'automatic') {
            throw new BusinessRuleError('Hago Nobility products must use automatic fulfillment.', 'HAGO_AUTOMATIC_EXECUTION_REQUIRED');
        }
        if (Number(quantity) !== 1) {
            throw new BusinessRuleError('Hago Nobility quantity must be exactly one.', 'HAGO_NOBILITY_FIXED_QUANTITY_REQUIRED');
        }
        const normalizedTargetId = String(targetId ?? '').trim();
        if (!normalizedTargetId || !String(quoteRef ?? '').trim()) {
            throw new BusinessRuleError('A current Hago Nobility quote is required.', 'HAGO_NOBILITY_QUOTE_REQUIRED');
        }
        const existingOrder = await this.Order.findOne({
            userId,
            'hagoNobility.quoteRef': String(quoteRef).trim(),
        });
        if (existingOrder) return { existingOrder };
        const unresolved = await this.Order.exists({
            userId,
            productId: product._id,
            'hagoNobility.requestedTargetId': normalizedTargetId,
            'hagoNobility.mutationState': {
                $in: [
                    HAGO_FINANCIAL_MUTATION_STATES.READY,
                    HAGO_FINANCIAL_MUTATION_STATES.CLAIMED,
                    HAGO_FINANCIAL_MUTATION_STATES.SENT,
                    HAGO_FINANCIAL_MUTATION_STATES.PENDING,
                    HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN,
                ],
            },
        });
        if (unresolved) {
            throw new BusinessRuleError('A Hago Nobility order for this target is still awaiting confirmation. Do not submit it again.', 'HAGO_NOBILITY_RECONCILIATION_REQUIRED');
        }
        const quote = await this.commerce.validateQuote({ quoteRef, userId, productId: product._id, targetId: normalizedTargetId });
        const user = await this.User.findById(userId).select('currency');
        const providerProduct = await this.ProviderProduct.findById(product.providerProduct)
            .select('externalProductId');
        const configuredPrice = quote.operation === 'RENEW'
            ? product.hagoNobilityPricing?.renewalBasePrice
            : product.hagoNobilityPricing?.purchaseBasePrice;
        if (
            product.pricingStrategy !== PRICING_STRATEGIES.HAGO_NOBILITY_READINESS
            || deriveNobilityType(providerProduct) !== quote.selectedType
            || String(configuredPrice ?? '') !== String(quote.branchBasePrice ?? '')
            || !user
            || String(user.currency ?? '').toUpperCase() !== String(quote.currency ?? '').toUpperCase()
        ) {
            throw new BusinessRuleError('This Hago Nobility quote no longer matches the product configuration. Refresh the quote and try again.', 'HAGO_NOBILITY_QUOTE_MISMATCH');
        }
        return { quote };
    }

    buildOrderSnapshot(prepared, orderId) {
        const quote = prepared?.quote;
        if (!quote) return null;
        return {
            serviceType: 'NOBILITY',
            quoteRef: quote.quoteRef,
            selectedType: quote.selectedType,
            selectedName: quote.selectedName,
            requestedTargetId: quote.targetId,
            operation: quote.operation,
            readinessAt: quote.readinessAt,
            readinessConfigFingerprint: quote.readinessConfigFingerprint,
            pricingBranch: quote.pricingBranch,
            branchBasePrice: quote.branchBasePrice,
            connectionRef: quote.connectionRef,
            providerMutationKey: `hago:nobility:${String(orderId)}`,
            mutationState: HAGO_FINANCIAL_MUTATION_STATES.READY,
        };
    }

    async _refund(order) {
        return this.refundFailedOrder ? this.refundFailedOrder(order) : false;
    }

    async _markUnknown(orderId, evidence = {}) {
        const now = this.now();
        const updated = await this.Order.findOneAndUpdate(
            { _id: orderId, 'hagoNobility.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.READY, HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING] } },
            { $set: {
                status: ORDER_STATUS.MANUAL_REVIEW,
                'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN,
                'hagoNobility.outcomeAt': now,
                'hagoNobility.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoNobility.providerStatus': evidence.providerStatus ?? null,
                'hagoNobility.providerCode': evidence.providerCode ?? null,
                'hagoNobility.unknownReason': evidence.unknownReason ?? HAGO_FINANCIAL_UNKNOWN_REASONS.UPSTREAM_UNKNOWN,
                lastCheckedAt: now,
            } },
            { new: true }
        );
        return updated ?? this.Order.findById(orderId);
    }

    async _settleSuccess(orderId, evidence) {
        return this.Order.findOneAndUpdate(
            { _id: orderId, status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] }, 'hagoNobility.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] } },
            { $set: {
                status: ORDER_STATUS.COMPLETED,
                providerStatus: 'SUCCESS',
                'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SUCCESS,
                'hagoNobility.outcomeAt': this.now(),
                'hagoNobility.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoNobility.providerStatus': evidence.providerStatus ?? 'SUCCESS',
                'hagoNobility.providerCode': evidence.providerCode ?? null,
                lastCheckedAt: this.now(),
            } },
            { new: true }
        );
    }

    async _settleAuthoritativeFailure(orderId, evidence) {
        const order = await this.Order.findOneAndUpdate(
            { _id: orderId, status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] }, 'hagoNobility.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] } },
            { $set: {
                status: ORDER_STATUS.FAILED,
                failedAt: this.now(),
                providerStatus: 'FAILED',
                'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.FAILED,
                'hagoNobility.outcomeAt': this.now(),
                'hagoNobility.providerTransactionId': evidence.providerTransactionId ?? null,
                'hagoNobility.providerStatus': evidence.providerStatus ?? 'FAILED',
                'hagoNobility.providerCode': evidence.providerCode ?? null,
                lastCheckedAt: this.now(),
            } },
            { new: true }
        );
        if (!order) return this.Order.findById(orderId);
        await this._refund(order);
        return this.Order.findById(orderId);
    }

    async _resolveForExecution(order) {
        const [product, connection] = await Promise.all([
            this.Product.findById(order.productId),
            this.Connection.findById(order.hagoNobility.connectionRef).select('+connectionId'),
        ]);
        if (!product || product.pricingStrategy !== PRICING_STRATEGIES.HAGO_NOBILITY_READINESS || !connection?.connectionId) return null;
        const [provider, providerProduct] = await Promise.all([
            this.Provider.findById(product.provider).select('slug isActive deletedAt'),
            this.ProviderProduct.findById(product.providerProduct).select('provider externalProductId isActive'),
        ]);
        if (!provider || provider.deletedAt || !provider.isActive || provider.slug !== 'hago' || !providerProduct?.isActive || String(providerProduct.provider) !== String(provider._id) || deriveNobilityType(providerProduct) !== order.hagoNobility.selectedType) return null;
        return { provider, connection };
    }

    async execute(orderId) {
        const order = await this.Order.findById(orderId).select('+hagoNobility.connectionRef +hagoNobility.providerMutationKey +hagoNobility.providerTransactionId');
        if (!order?.hagoNobility?.serviceType) return { handled: false };
        if (order.status !== ORDER_STATUS.PROCESSING || order.hagoNobility.mutationState !== HAGO_FINANCIAL_MUTATION_STATES.READY) return { handled: true, order, placed: false, refunded: false };
        const claimed = await this.Order.findOneAndUpdate(
            { _id: order._id, status: ORDER_STATUS.PROCESSING, 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.READY },
            { $set: { 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, 'hagoNobility.claimedAt': this.now() } },
            { new: true }
        ).select('+hagoNobility.connectionRef +hagoNobility.providerMutationKey +hagoNobility.providerTransactionId');
        if (!claimed) return { handled: true, order: await this.Order.findById(orderId), placed: false, refunded: false };
        let resolved;
        try {
            resolved = await this._resolveForExecution(claimed);
        } catch (_) {
            const failed = await this._settleAuthoritativeFailure(orderId, { providerStatus: 'NOT_SENT', providerCode: 'PRE_SEND_RESOLUTION' });
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }
        if (!resolved || !isHagoNobilityEnabled(this.env)) {
            const failed = await this._settleAuthoritativeFailure(orderId, { providerStatus: 'NOT_SENT', providerCode: 'PRE_SEND_CONFIGURATION' });
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }
        // SENT is durable before the irreversible HTTP request. A process crash
        // from this point is therefore treated as ambiguous and never resent.
        let sent;
        try {
            sent = await this.Order.findOneAndUpdate(
                { _id: claimed._id, 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.CLAIMED },
                { $set: { 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SENT, 'hagoNobility.sentAt': this.now() } },
                { new: true }
            ).select('+hagoNobility.connectionRef +hagoNobility.providerMutationKey +hagoNobility.providerTransactionId');
        } catch (_) {
            // No HTTP mutation has been started on this path. Even if Mongo
            // committed before reporting an error, this process has not yet
            // reached HAGO-BOT, so NOT_SENT remains a safe refund outcome.
            const failed = await this._settleAuthoritativeFailure(orderId, { providerStatus: 'NOT_SENT', providerCode: 'PRE_SEND_STATE_PERSISTENCE' });
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }
        if (!sent) return { handled: true, order: await this.Order.findById(orderId), placed: false, refunded: false };
        let outcome;
        try {
            const response = await this.adapterFactory(resolved.provider).executeControlledNobility({
                connectionId: resolved.connection.connectionId,
                targetId: sent.hagoNobility.requestedTargetId,
                nobilityType: sent.hagoNobility.selectedType,
                idempotencyKey: sent.hagoNobility.providerMutationKey,
            });
            outcome = classifyHagoMutation(response);
        } catch (error) {
            outcome = { outcome: 'UNKNOWN', unknownReason: classifyHagoError(error) };
        }
        if (outcome.outcome === 'SUCCESS') return { handled: true, order: await this._settleSuccess(orderId, outcome), placed: true, refunded: false };
        if (outcome.outcome === 'AUTHORITATIVE_FAILED') {
            const failed = await this._settleAuthoritativeFailure(orderId, outcome);
            return { handled: true, order: failed, placed: false, refunded: Boolean(failed?.refunded) };
        }
        if (outcome.outcome === 'PENDING') {
            // A pending response is safe to reconcile only when it gives us a
            // durable, provider-issued reference for the read-only status API.
            // Without one, resending could create a second Nobility mutation.
            if (!outcome.providerTransactionId) {
                return {
                    handled: true,
                    order: await this._markUnknown(orderId, {
                        ...outcome,
                        unknownReason: HAGO_FINANCIAL_UNKNOWN_REASONS.MALFORMED_RESPONSE,
                    }),
                    placed: true,
                    refunded: false,
                };
            }
            const pending = await this.Order.findOneAndUpdate(
                { _id: orderId, 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.SENT },
                { $set: { 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.PENDING, 'hagoNobility.providerTransactionId': outcome.providerTransactionId ?? null, 'hagoNobility.providerStatus': outcome.providerStatus ?? 'SEND_PENDING', 'hagoNobility.providerCode': outcome.providerCode ?? null, lastCheckedAt: this.now() } },
                { new: true }
            );
            return { handled: true, order: pending, placed: true, refunded: false };
        }
        return { handled: true, order: await this._markUnknown(orderId, outcome), placed: false, refunded: false };
    }

    async reconcile(orderId) {
        const order = await this.Order.findById(orderId).select('+hagoNobility.connectionRef +hagoNobility.providerTransactionId');
        if (!order?.hagoNobility?.serviceType || ![HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN, HAGO_FINANCIAL_MUTATION_STATES.PENDING].includes(order.hagoNobility.mutationState)) throw new BusinessRuleError('This order has no unresolved Hago Nobility outcome.', 'HAGO_RECONCILIATION_NOT_REQUIRED');
        const connection = await this.Connection.findById(order.hagoNobility.connectionRef).select('+connectionId');
        if (!connection?.connectionId || !order.hagoNobility.providerTransactionId) return this._unresolved(orderId);
        try {
            // These are the HAGO-BOT transaction-status/manual-review APIs.
            // Reconciliation intentionally has no adapter and never reaches
            // executeControlledNobility or the auto-recharge endpoint.
            const latest = await this.client.lookupTransaction(connection.connectionId, order.hagoNobility.providerTransactionId);
            await this.client.reconcileTransaction(connection.connectionId, order.hagoNobility.providerTransactionId);
            const outcome = classifyHagoMutation({ data: { transaction: latest } });
            if (outcome.outcome === 'SUCCESS') return { order: await this._settleSuccess(orderId, outcome), outcome: 'SUCCESS' };
            if (outcome.outcome === 'AUTHORITATIVE_FAILED') return { order: await this._settleAuthoritativeFailure(orderId, outcome), outcome: 'FAILED' };
        } catch (_) { /* unresolved below */ }
        return this._unresolved(orderId);
    }

    async _unresolved(orderId) {
        const order = await this.Order.findByIdAndUpdate(
            orderId,
            {
                $set: {
                    'hagoNobility.lastReconciledAt': this.now(),
                    'hagoNobility.unknownReason': HAGO_FINANCIAL_UNKNOWN_REASONS.RECONCILIATION_UNRESOLVED,
                },
                $inc: { 'hagoNobility.reconciliationAttempts': 1 },
            },
            { new: true }
        );
        if (
            order
            && order.hagoNobility?.reconciliationAttempts >= HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS
            && order.hagoNobility?.mutationState === HAGO_FINANCIAL_MUTATION_STATES.PENDING
        ) {
            const manualReview = await this.Order.findOneAndUpdate(
                { _id: orderId, 'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.PENDING },
                {
                    $set: {
                        status: ORDER_STATUS.MANUAL_REVIEW,
                        'hagoNobility.mutationState': HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN,
                        'hagoNobility.outcomeAt': this.now(),
                    },
                },
                { new: true }
            );
            return { order: manualReview ?? order, outcome: 'UNRESOLVED' };
        }
        return { order, outcome: 'UNRESOLVED' };
    }

    async reconcileScheduled({ limit = 20 } = {}) {
        const dueBefore = new Date(this.now().getTime() - HAGO_FINANCIAL_RECONCILIATION_INTERVAL_MS);
        const orders = await this.Order.find({ providerCode: 'hago', status: { $in: [ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] }, 'hagoNobility.mutationState': { $in: [HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN] }, 'hagoNobility.providerTransactionId': { $ne: null }, 'hagoNobility.reconciliationAttempts': { $lt: HAGO_FINANCIAL_RECONCILIATION_MAX_ATTEMPTS }, $or: [{ 'hagoNobility.lastReconciledAt': null }, { 'hagoNobility.lastReconciledAt': { $lte: dueBefore } }] }).sort({ 'hagoNobility.lastReconciledAt': 1 }).limit(Math.max(1, Math.min(Number(limit) || 20, 50))).select('_id');
        const results = [];
        for (const order of orders) {
            try { results.push(await this.reconcile(order._id)); } catch (_) { /* one record must not stop the queue */ }
        }
        return results;
    }

    async markUnexpectedExecutionError(orderId) {
        return this._markUnknown(orderId, { unknownReason: HAGO_FINANCIAL_UNKNOWN_REASONS.TRANSPORT_AMBIGUOUS });
    }

    isRefundBlocked(order) {
        return Boolean(order?.hagoNobility?.serviceType) && [HAGO_FINANCIAL_MUTATION_STATES.CLAIMED, HAGO_FINANCIAL_MUTATION_STATES.SENT, HAGO_FINANCIAL_MUTATION_STATES.PENDING, HAGO_FINANCIAL_MUTATION_STATES.UNKNOWN].includes(order.hagoNobility.mutationState);
    }
}

module.exports = { HagoNobilityExecutionService, isHagoNobilityEnabled };
