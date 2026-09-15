'use strict';
const crypto = require('crypto');
const { Order, ORDER_STATUS } = require('../../orders/order.model');
const { Product } = require('../../products/product.model');
const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const { InchillProviderConnection, INCHILL_CONNECTION_STATUS } = require('./inchillProviderConnection.model');
const { InchillClient, InchillClientError } = require('./inchill.client');
const { INCHILL_SESSION_VALIDATION_STATUS, normalizeInchillSessionValidationStatus } = require('./inchillSessionValidation');
const { BusinessRuleError } = require('../../../shared/errors/AppError');

const STATES = Object.freeze({ READY: 'READY', CLAIMED: 'CLAIMED', SENT: 'SENT', SUCCESS: 'SUCCESS', FAILED: 'FAILED', PENDING: 'PENDING', UNKNOWN: 'UNKNOWN' });
const TARGET_KEYS = new Set(['targetid', 'target_id', 'vid', 'inchillid', 'inchill_id', 'playerid', 'player_id', 'userid', 'user_id', 'uid', 'target']);
const isInchillDiamondEnabled = (env = process.env) => env.INCHILL_DIAMOND_FULFILLMENT_ENABLED === 'true';
const isInchillDiamond = (provider, product) => provider?.slug === 'inchill' && (String(product?.externalProductId) === 'INCHILL_DIAMOND_AMOUNT' || product?.rawPayload?.metadata?.serviceType === 'DIAMOND');
const trustedTarget = (values = {}, mapping = {}) => {
    const found = Object.entries(values).filter(([key, value]) => TARGET_KEYS.has(String(key).toLowerCase()) || TARGET_KEYS.has(String(mapping?.[key] ?? '').toLowerCase())).map(([, value]) => String(value ?? '').trim()).filter(Boolean);
    if (new Set(found).size !== 1) throw new BusinessRuleError('A single Inchill target ID is required.', 'INCHILL_TARGET_INVALID');
    return found[0];
};
const fingerprint = ({ providerId, targetId, amount }) => crypto.createHash('sha256').update(JSON.stringify({ providerId: String(providerId), targetId, amount: Number(amount), serviceType: 'DIAMOND' })).digest('hex');

class InchillFinancialExecutionService {
    constructor({ orderModel = Order, productModel = Product, providerModel = Provider, providerProductModel = ProviderProduct, connectionModel = InchillProviderConnection, client = new InchillClient(), refundFailedOrder = null, now = () => new Date(), env = process.env } = {}) { Object.assign(this, { Order: orderModel, Product: productModel, Provider: providerModel, ProviderProduct: providerProductModel, Connection: connectionModel, client, refundFailedOrder, now, env }); }
    async resolveProduct(product) { if (!product?.provider || !product?.providerProduct) return null; const [provider, providerProduct] = await Promise.all([this.Provider.findById(product.provider).select('slug isActive deletedAt'), this.ProviderProduct.findById(product.providerProduct).select('externalProductId rawPayload provider')]); return isInchillDiamond(provider, providerProduct) ? { provider, providerProduct } : null; }
    async _connection(providerId) { return this.Connection.findOne({ provider: providerId, isPrimary: true, enabled: true }).select('+agentPhone'); }
    async _preflight(connection, targetId, amount) {
        if (!connection?.agentPhone) throw new BusinessRuleError('No enabled Inchill connection is available.', 'INCHILL_CONNECTION_REQUIRED');
        const validation = await this.client.validateSession(connection.agentPhone);
        const session = normalizeInchillSessionValidationStatus(validation);
        if (session === INCHILL_SESSION_VALIDATION_STATUS.REJECTED) throw new BusinessRuleError('The Inchill connection requires reauthentication.', 'INCHILL_REAUTHENTICATION_REQUIRED');
        if (session !== INCHILL_SESSION_VALIDATION_STATUS.VALID) throw new BusinessRuleError('The Inchill session is not safe for a recharge.', 'INCHILL_SESSION_UNKNOWN');
        const identity = await this.client.verifyTarget(connection.agentPhone, targetId);
        if (!identity.data?.userInfo?.vid && !identity.data?.userInfo?.nick) throw new BusinessRuleError('The Inchill ID is invalid or unavailable.', 'INCHILL_TARGET_INVALID');
        const checked = await this.client.rechargePreflight(connection.agentPhone, targetId, amount);
        const preflight = checked.data?.preflight;
        if (!preflight || preflight.readOnly !== true || preflight.mutationAttempted !== false || !['VALID', 'CONNECTED'].includes(String(preflight.session ?? '').toUpperCase()) || preflight.targetResolved !== true || preflight.serviceType !== 'DIAMOND' || preflight.walletSufficient !== true || String(preflight.target?.vid) !== String(targetId) || Number(preflight.amount) !== Number(amount)) {
            if (preflight?.walletSufficient === false) throw new BusinessRuleError('The Inchill provider balance is unavailable.', 'INCHILL_INSUFFICIENT_PROVIDER_BALANCE');
            throw new BusinessRuleError('Inchill recharge preflight failed.', 'INCHILL_PREFLIGHT_FAILED');
        }
        return preflight;
    }
    async prepareNewOrder({ product, quantity, customerInput }) {
        const resolved = await this.resolveProduct(product); if (!resolved) return null;
        if (!isInchillDiamondEnabled(this.env)) throw new BusinessRuleError('Inchill Diamond checkout is not enabled.', 'INCHILL_FINANCIAL_CHECKOUT_NOT_ENABLED');
        const amount = Number(quantity); if (!Number.isFinite(amount) || amount <= 0) throw new BusinessRuleError('Inchill amount must be positive.', 'INCHILL_INVALID_AMOUNT');
        if (product.executionType !== 'automatic') throw new BusinessRuleError('Inchill Diamond products must use automatic fulfillment.', 'INCHILL_AUTOMATIC_EXECUTION_REQUIRED');
        const targetId = trustedTarget(customerInput?.values, product.providerMapping); const connection = await this._connection(resolved.provider._id); await this._preflight(connection, targetId, amount);
        return { provider: resolved.provider, targetId, providerAmount: amount, connectionRef: connection._id, fingerprint: fingerprint({ providerId: resolved.provider._id, targetId, amount }) };
    }
    buildOrderSnapshot(prepared, orderId) { return { serviceType: 'DIAMOND', requestedTargetId: prepared.targetId, providerAmount: prepared.providerAmount, connectionRef: prepared.connectionRef, providerMutationKey: `inchill:${String(orderId)}:${crypto.randomUUID()}`, intentFingerprint: prepared.fingerprint, mutationState: STATES.READY }; }
    async customerPreflight({ product, targetId, amount }) { const resolved = await this.resolveProduct(product); if (!resolved) throw new BusinessRuleError('This product is not an Inchill Diamond product.', 'INCHILL_PRODUCT_REQUIRED'); if (!isInchillDiamondEnabled(this.env)) throw new BusinessRuleError('Inchill Diamond checkout is not enabled.', 'INCHILL_FINANCIAL_CHECKOUT_NOT_ENABLED'); const connection = await this._connection(resolved.provider._id); const preflight = await this._preflight(connection, String(targetId ?? '').trim(), amount); return { ready: true, serviceType: 'DIAMOND', target: { vid: String(preflight.target.vid) } }; }
    async execute(orderId) {
        const order = await this.Order.findById(orderId).select('+inchillFinancial.connectionRef +inchillFinancial.providerMutationKey +inchillFinancial.providerTransactionId +inchillFinancial.intentFingerprint');
        if (!order?.inchillFinancial?.serviceType) return { handled: false }; if (order.status !== ORDER_STATUS.PROCESSING || order.inchillFinancial.mutationState !== STATES.READY) return { handled: true, order, placed: false };
        if (!isInchillDiamondEnabled(this.env)) return this._failedNotSent(orderId, 'INCHILL_FINANCIAL_CHECKOUT_NOT_ENABLED');
        const claimed = await this.Order.findOneAndUpdate({ _id: order._id, status: ORDER_STATUS.PROCESSING, 'inchillFinancial.mutationState': STATES.READY }, { $set: { 'inchillFinancial.mutationState': STATES.CLAIMED, 'inchillFinancial.claimedAt': this.now() } }, { new: true }).select('+inchillFinancial.connectionRef +inchillFinancial.providerMutationKey +inchillFinancial.intentFingerprint');
        if (!claimed) return { handled: true, order: await this.Order.findById(orderId), placed: false };
        const connection = await this.Connection.findById(claimed.inchillFinancial.connectionRef).select('+agentPhone');
        if (!connection || fingerprint({ providerId: connection.provider, targetId: claimed.inchillFinancial.requestedTargetId, amount: claimed.inchillFinancial.providerAmount }) !== claimed.inchillFinancial.intentFingerprint) return this._unknown(orderId, 'FINGERPRINT_MISMATCH');
        try { await this._preflight(connection, claimed.inchillFinancial.requestedTargetId, claimed.inchillFinancial.providerAmount); }
        catch (error) { return this._failedNotSent(orderId, error?.code ?? 'PREFLIGHT_FAILED'); }
        const sent = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': STATES.CLAIMED }, { $set: { 'inchillFinancial.mutationState': STATES.SENT, 'inchillFinancial.sentAt': this.now() } }, { new: true }).select('+inchillFinancial.providerMutationKey');
        if (!sent) return { handled: true, order: await this.Order.findById(orderId), placed: false };
        let response;
        try { response = await this.client.rechargeDiamond(connection.agentPhone, sent.inchillFinancial.requestedTargetId, sent.inchillFinancial.providerAmount, sent.inchillFinancial.providerMutationKey); }
        catch (error) { return this._unknown(orderId, error?.code === 'INCHILL_TIMEOUT' ? 'TIMEOUT' : 'MUTATION_TRANSPORT'); }
        const transaction = response.data?.transaction ?? {}; const status = String(transaction.status ?? '').toUpperCase(); const upstream = String(transaction.upstreamStatus ?? '').toUpperCase(); const evidence = { 'inchillFinancial.providerTransactionId': transaction.id ? String(transaction.id) : null, 'inchillFinancial.providerStatus': upstream || null, 'inchillFinancial.providerCode': transaction.upstreamCode == null ? null : String(transaction.upstreamCode), 'inchillFinancial.timeout': Boolean(transaction.upstreamTimeout), 'inchillFinancial.outcomeAt': this.now() };
        if (status === 'SUCCESS' && upstream === 'SUCCESS') { const settled = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': STATES.SENT }, { $set: { status: ORDER_STATUS.COMPLETED, providerStatus: 'SUCCESS', 'inchillFinancial.mutationState': STATES.SUCCESS, ...evidence } }, { new: true }); return { handled: true, order: settled, placed: true, refunded: false }; }
        if (status === 'FAILED' && upstream === 'FAILED') { const failed = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': STATES.SENT }, { $set: { status: ORDER_STATUS.FAILED, providerStatus: 'FAILED', failedAt: this.now(), 'inchillFinancial.mutationState': STATES.FAILED, ...evidence } }, { new: true }); if (failed && this.refundFailedOrder) await this.refundFailedOrder(failed); return { handled: true, order: failed, placed: false, refunded: Boolean(failed) }; }
        if (upstream === 'SEND_PENDING' || status === 'PENDING') { const pending = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': STATES.SENT }, { $set: { 'inchillFinancial.mutationState': STATES.PENDING, ...evidence } }, { new: true }); return { handled: true, order: pending, placed: true }; }
        return this._unknown(orderId, upstream === 'NOT_SENT' ? 'NOT_SENT' : transaction.upstreamTimeout ? 'TIMEOUT' : 'UNKNOWN', evidence);
    }
    async _failedNotSent(orderId, reason) { const failed = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': { $in: [STATES.READY, STATES.CLAIMED] } }, { $set: { status: ORDER_STATUS.FAILED, providerStatus: 'NOT_SENT', failedAt: this.now(), 'inchillFinancial.mutationState': STATES.FAILED, 'inchillFinancial.providerStatus': 'NOT_SENT', 'inchillFinancial.unknownReason': String(reason), 'inchillFinancial.outcomeAt': this.now() } }, { new: true }); if (failed && this.refundFailedOrder) await this.refundFailedOrder(failed); return { handled: true, order: failed, placed: false, refunded: Boolean(failed) }; }
    async _unknown(orderId, reason, evidence = {}) { const updated = await this.Order.findOneAndUpdate({ _id: orderId, 'inchillFinancial.mutationState': { $in: [STATES.READY, STATES.CLAIMED, STATES.SENT, STATES.PENDING] } }, { $set: { status: ORDER_STATUS.MANUAL_REVIEW, 'inchillFinancial.mutationState': STATES.UNKNOWN, 'inchillFinancial.unknownReason': reason, 'inchillFinancial.outcomeAt': this.now(), ...evidence } }, { new: true }); return { handled: true, order: updated ?? await this.Order.findById(orderId), placed: false, refunded: false }; }
    async reconcile(orderId, history = {}) { const order = await this.Order.findById(orderId).select('+inchillFinancial.connectionRef +inchillFinancial.providerTransactionId'); if (!order?.inchillFinancial?.serviceType) throw new BusinessRuleError('This is not an Inchill financial order.', 'INCHILL_ORDER_REQUIRED'); if (order.inchillFinancial.mutationState !== STATES.UNKNOWN || String(order.inchillFinancial.providerStatus).toUpperCase() === 'NOT_SENT') throw new BusinessRuleError('Only an attempted unknown Inchill mutation can be reconciled.', 'INCHILL_RECONCILIATION_NOT_APPLICABLE'); if (!order.inchillFinancial.providerTransactionId) throw new BusinessRuleError('The Inchill transaction reference is unavailable.', 'INCHILL_RECONCILIATION_NOT_APPLICABLE'); const connection = await this.Connection.findById(order.inchillFinancial.connectionRef).select('+agentPhone'); if (!connection?.agentPhone) throw new BusinessRuleError('No enabled Inchill connection is available.', 'INCHILL_CONNECTION_REQUIRED'); const result = await this.client.reconcileRecharge(connection.agentPhone, order.inchillFinancial.providerTransactionId, history); const reconciliation = result.data?.reconciliation; if (String(reconciliation?.outcome).toUpperCase() !== 'UNKNOWN') throw new BusinessRuleError('Inchill returned an unexpected reconciliation response.', 'INCHILL_RECONCILIATION_UNAVAILABLE'); await this.Order.findByIdAndUpdate(orderId, { $set: { 'inchillFinancial.lastReconciledAt': this.now() }, $inc: { 'inchillFinancial.reconciliationAttempts': 1 } }); return { outcome: 'UNKNOWN', reconciliation: { wallet: reconciliation.wallet ?? null, history: reconciliation.history ?? null } }; }
    isRefundBlocked(order) { return ['UNKNOWN', 'PENDING', 'SENT', 'CLAIMED'].includes(String(order?.inchillFinancial?.mutationState ?? '').toUpperCase()); }
}
module.exports = { InchillFinancialExecutionService, INCHILL_FINANCIAL_MUTATION_STATES: STATES, isInchillDiamond, isInchillDiamondEnabled };
