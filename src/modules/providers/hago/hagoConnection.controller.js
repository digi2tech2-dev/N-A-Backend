'use strict';

const catchAsync = require('../../../shared/utils/catchAsync');
const { sendSuccess } = require('../../../shared/utils/apiResponse');
const { hagoConnectionService } = require('./hagoConnection.service');

// These controllers deliberately return only service DTOs. Never return a
// HagoProviderConnection document or upstream Hago response directly.
const createLoginChallenge = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.createLoginChallenge(req.params.id, req.body);
    sendSuccess(res, data, 'Hago login challenge created.');
});

const verifyLoginChallenge = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.verifyLoginChallenge(req.params.id, req.body);
    sendSuccess(res, data, 'Hago connection verified.');
});

const getConnection = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.getConnection(req.params.id);
    sendSuccess(res, data, 'Hago connection retrieved.');
});

const validateSession = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.validateSession(req.params.id);
    sendSuccess(res, data, 'Hago session validated.');
});

const getReadiness = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.getReadiness(req.params.id);
    sendSuccess(res, data, 'Hago readiness retrieved.');
});

const getAgentProfile = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.getAgentProfile(req.params.id);
    sendSuccess(res, data, 'Hago agent profile retrieved.');
});

const getWalletBalance = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.getWalletBalance(req.params.id);
    sendSuccess(res, data, 'Hago wallet balance retrieved.');
});

const verifyTarget = catchAsync(async (req, res) => {
    const data = await hagoConnectionService.verifyTarget(req.params.id, req.body);
    sendSuccess(res, data, 'Hago target verified.');
});

module.exports = {
    createLoginChallenge,
    verifyLoginChallenge,
    getConnection,
    validateSession,
    getReadiness,
    getAgentProfile,
    getWalletBalance,
    verifyTarget,
};
