'use strict';

const orderService = require('./order.service');
const { isExactLedgerEnabled } = require('../wallet/exactLedger.service');
const { serializeExactCompatibleOrder } = require('../../shared/utils/exactLedgerCompatibility');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

const resolveAuditContext = (req) => req.auditContext ?? {
    actorId: req.user?._id,
    actorRole: String(req.user?.role || '').toUpperCase(),
    ipAddress: req.ip ?? null,
    userAgent: req.get('User-Agent') ?? null,
};

const normalizeCustomInputsPayload = (customInputs) => {
    if (!customInputs) return {};

    if (Array.isArray(customInputs)) {
        return customInputs.reduce((acc, item) => {
            if (!item || typeof item !== 'object') return acc;

            const fieldKey = String(
                item.key ?? item.name ?? item.label ?? item.field ?? item.id ?? ''
            ).trim();
            if (!fieldKey) return acc;

            const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
            const resolvedValue = hasValue
                ? item.value
                : (item.input ?? item.answer ?? item.data);

            if (resolvedValue !== undefined) {
                acc[fieldKey] = resolvedValue;
            }

            return acc;
        }, {});
    }

    if (typeof customInputs === 'object') {
        return { ...customInputs };
    }

    return {};
};

// `select: false` protects fetched documents, but newly-created Mongoose
// documents still contain their in-memory private fields. Keep the customer
// API boundary explicit so a checkout response cannot disclose provider
// credentials, mutation identifiers, cost, or raw upstream evidence.
const serializeCustomerOrder = (order) => {
    let serialized = order?.toObject ? order.toObject() : { ...order };
    if (isExactLedgerEnabled() && [
        'chargedAmountUnits',
        'walletDeductedUnits',
        'creditUsedAmountUnits',
    ].some((field) => Object.prototype.hasOwnProperty.call(serialized, field))) {
        serialized = serializeExactCompatibleOrder(serialized);
    }
    delete serialized.providerRawResponse;
    if (!serialized?.hagoNobility) return serialized;

    [
        'quoteRef',
        'readinessConfigFingerprint',
        'branchBasePrice',
        'providerDiamondCost',
        'providerCostCurrency',
        'connectionRef',
        'providerMutationKey',
        'providerTransactionId',
        'providerCode',
        'unknownReason',
    ].forEach((field) => delete serialized.hagoNobility[field]);
    return serialized;
};

// ── Customer Endpoints ────────────────────────────────────────────────────────

const createOrder = catchAsync(async (req, res) => {
    const { productId, quantity, orderFieldsValues, customInputs, link, target, hagoNobility } = req.body;

    // Merge top-level link/target into orderFieldsValues so they always
    // reach customerInput (SMM providers need these as provider params).
    const normalizedOrderFieldsValues = (orderFieldsValues && typeof orderFieldsValues === 'object' && !Array.isArray(orderFieldsValues))
        ? orderFieldsValues
        : {};
    const mergedFields = {
        ...normalizedOrderFieldsValues,
        ...normalizeCustomInputsPayload(customInputs),
    };
    if (link && !mergedFields.link) mergedFields.link = link;
    if (target && !mergedFields.target) mergedFields.target = target;
    const finalFields = Object.keys(mergedFields).length > 0 ? mergedFields : null;

    // Extract optional idempotency key from header
    const idempotencyKey = req.headers['idempotency-key'] || null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: 'CUSTOMER',
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10),
        idempotencyKey,
        orderFieldsValues: finalFields,
        hagoNobilityQuoteRef: hagoNobility?.quoteRef,
        hagoNobilityTargetId: hagoNobility?.targetId,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, serializeCustomerOrder(order), 'Order already exists (idempotent response).');
    }

    if (['READY', 'CLAIMED', 'SENT', 'PENDING', 'UNKNOWN'].includes(order?.hagoNobility?.mutationState)) {
        return sendSuccess(
            res,
            serializeCustomerOrder(order),
            'Hago Nobility order received and pending confirmation.',
            202
        );
    }

    sendCreated(res, serializeCustomerOrder(order), 'Order placed successfully.');
});

const getMyOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { orders, pagination } = await orderService.listOrdersForUser(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, orders.map(serializeCustomerOrder), pagination, 'Orders retrieved successfully.');
});

const getMyOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, serializeCustomerOrder(order));
});

// ── Admin Endpoints ───────────────────────────────────────────────────────────

const getAllOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    const { orders, pagination } = await orderService.listAllOrders({ page, limit, status });
    sendPaginated(res, orders, pagination, 'Orders retrieved successfully.');
});

const adminGetOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id);
    sendSuccess(res, order);
});

const failOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsFailed(req.params.id, resolveAuditContext(req));
    sendSuccess(res, order, 'Order marked as failed and refund issued.');
});

const completeOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsCompleted(req.params.id, resolveAuditContext(req));
    sendSuccess(res, order, 'Order marked as completed.');
});

module.exports = {
    createOrder,
    getMyOrders,
    getMyOrder,
    getAllOrders,
    adminGetOrder,
    failOrder,
    completeOrder,
};
