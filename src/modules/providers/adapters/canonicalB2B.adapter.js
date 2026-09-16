'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

const DEFAULT_TIMEOUT_MS = 180_000;
const SECRET_KEY = /token|api[_-]?key|authorization|password|secret/i;
const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    return Object.entries(value).reduce((result, [key, item]) => {
        result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item);
        return result;
    }, {});
};
const normaliseBaseUrl = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');
const details = (error) => ({
    status: error?.response?.status ?? error?.statusCode ?? null,
    body: sanitize(error?.response?.data ?? error?.providerBody ?? null),
    code: error?.code || null,
    message: String(error?.message || 'Provider request failed'),
});
const uncertain = (error) => {
    const info = details(error);
    if ([111, 130].includes(Number(info.body?.code)) || (info.status && info.status < 500)) return false;
    return Boolean(info.status >= 500 || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED'].includes(info.code)
        || /timeout|socket|network|connection reset/i.test(info.message));
};

class CanonicalB2BAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        const baseURL = normaliseBaseUrl(provider.baseUrl);
        if (!baseURL) throw new Error('[CanonicalB2B] provider.baseUrl is required');
        if (!token) throw new Error('[CanonicalB2B] api token is required');
        this._client = options.httpClient || axios.create({
            baseURL, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            headers: { 'api-token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
        });
    }

    async getBalance() {
        const { data } = await this._client.get('/profile');
        return { balance: data?.balance, currency: data?.currency, email: data?.email, rawResponse: sanitize(data) };
    }

    async getProducts() {
        const { data } = await this._client.get('/products');
        const products = Array.isArray(data) ? data : (data?.products ?? data?.data?.products ?? []);
        if (!Array.isArray(products)) throw new Error('[CanonicalB2B] invalid product list');
        return products.map((product) => {
            const currency = product.currency == null ? 'USD' : String(product.currency).trim().toUpperCase();
            if (currency !== 'USD') throw new Error(`[CanonicalB2B] product ${product.id ?? '<unknown>'} currency ${currency} is unsupported`);
            const range = product.qty_values && typeof product.qty_values === 'object' && !Array.isArray(product.qty_values)
                ? product.qty_values : null;
            return this._validateDTO({
                externalProductId: String(product.id), rawName: String(product.name || 'Unknown'), rawPrice: String(product.price),
                minQty: range?.min ?? 1, maxQty: range?.max ?? 1, isActive: product.available !== false,
                rawPayload: sanitize(product),
            });
        });
    }

    _items(data) { return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []); }
    _check(item) {
        if (!item || item.order_id == null) return null;
        return { providerOrderId: item.order_id, providerStatus: item.status ?? 'wait', rawResponse: sanitize(item) };
    }
    async checkOrderByReference(referenceId) {
        const { data } = await this._client.get('/check', { params: { uuids: String(referenceId) } });
        const found = this._items(data).find((item) => String(item?.order_uuid || '') === String(referenceId));
        return found ? { found: true, ...this._check(found) } : { found: false, rawResponse: sanitize(data) };
    }
    async placeOrder(params = {}) {
        const externalProductId = String(params.externalProductId ?? params.providerProductId ?? '').trim();
        const referenceId = String(params.referenceId ?? '').trim();
        if (!/^\d+$/.test(externalProductId) || Number(externalProductId) <= 0 || !referenceId) {
            return { success: false, providerOrderId: null, providerStatus: 'reject', rawResponse: { validation: 'product_id_and_reference_required' }, errorMessage: 'Canonical product ID and reference are required' };
        }
        const { externalProductId: _externalProductId, providerProductId: _providerProductId, productId: _productId,
            quantity, amount: _amount, referenceId: _referenceId, price: _price, basePrice: _basePrice,
            providerPrice: _providerPrice, walletBalance: _walletBalance, balance: _balance, currency: _currency,
            orderId: _orderId, clientReference: _clientReference, providerIdempotencyKey: _providerIdempotencyKey,
            ...fields } = params;
        try {
            const { data } = await this._client.post('/orders', { product_id: Number(externalProductId), qty: quantity, order_uuid: referenceId, params: fields });
            const order = data?.data;
            if (data?.status !== 'OK' || !order?.order_id) return { success: false, providerOrderId: null, providerStatus: 'reject', rawResponse: sanitize(data), errorMessage: data?.message || 'Canonical provider rejected order' };
            return { success: true, providerOrderId: order.order_id, providerStatus: order.status ?? 'wait', rawResponse: sanitize(data), errorMessage: null };
        } catch (error) {
            if (uncertain(error)) {
                try {
                    const recovered = await this.checkOrderByReference(referenceId);
                    if (recovered.found) return { success: true, providerOrderId: recovered.providerOrderId, providerStatus: recovered.providerStatus, rawResponse: recovered.rawResponse, errorMessage: null };
                } catch (_) { /* preserve unknown outcome */ }
                return { success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN', outcomeUncertain: true, rawResponse: { placement: 'uncertain', ...details(error) }, errorMessage: null };
            }
            const info = details(error);
            return { success: false, providerOrderId: null, providerStatus: 'reject', rawResponse: info, errorMessage: info.body?.message || info.message };
        }
    }
    async checkOrders(orderIds = []) {
        if (!orderIds.length) return [];
        const { data } = await this._client.get('/check', { params: { orders: orderIds.join(',') } });
        const requested = new Set(orderIds.map(String));
        return this._items(data).map((item) => this._check(item)).filter((item) => item && requested.has(String(item.providerOrderId)));
    }
    async checkOrder(orderId) { return (await this.checkOrders([orderId])).find((item) => String(item.providerOrderId) === String(orderId)) || null; }
}

module.exports = { CanonicalB2BAdapter, sanitize, normaliseBaseUrl };
