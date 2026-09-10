'use strict';
const { inchillConnectionService } = require('./inchillConnection.service');
const { sendSuccess } = require('../../../shared/utils/apiResponse');
const catchAsync = require('../../../shared/utils/catchAsync');
const create = (method, message) => catchAsync(async (req, res) => sendSuccess(res, await inchillConnectionService[method](req.params.id, req.body), message));
module.exports = {
    sendOtp: create('sendOtp', 'Inchill OTP requested.'), verifyOtp: create('verifyOtp', 'Inchill connection verified.'),
    getConnection: catchAsync(async (req, res) => sendSuccess(res, await inchillConnectionService.getConnection(req.params.id), 'Inchill connection retrieved.')),
    validateSession: create('validateSession', 'Inchill session validated.'), getReadiness: catchAsync(async (req, res) => sendSuccess(res, await inchillConnectionService.getReadiness(req.params.id), 'Inchill readiness retrieved.')),
    getAgentProfile: catchAsync(async (req, res) => sendSuccess(res, await inchillConnectionService.getAgentProfile(req.params.id), 'Inchill profile retrieved.')),
    getWalletBalance: catchAsync(async (req, res) => sendSuccess(res, await inchillConnectionService.getWalletBalance(req.params.id), 'Inchill wallet retrieved.')),
    verifyTarget: create('verifyTarget', 'Inchill target verified.'),
};
