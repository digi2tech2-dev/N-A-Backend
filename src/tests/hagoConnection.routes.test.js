'use strict';

const http = require('http');
const jwt = require('jsonwebtoken');

const mockHagoConnectionService = {
    createLoginChallenge: jest.fn(),
    verifyLoginChallenge: jest.fn(),
    getConnection: jest.fn(),
    validateSession: jest.fn(),
    getReadiness: jest.fn(),
    getAgentProfile: jest.fn(),
    getWalletBalance: jest.fn(),
    verifyTarget: jest.fn(),
};

jest.mock('../modules/providers/hago/hagoConnection.service', () => ({
    hagoConnectionService: mockHagoConnectionService,
}));

const config = require('../config/config');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
} = require('./testHelpers');

const app = require('../app');

let server;
let baseUrl;

const requestJson = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
    }, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            try {
                resolve({ status: res.statusCode, body: responseBody ? JSON.parse(responseBody) : null });
            } catch (error) {
                reject(error);
            }
        });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});

const tokenFor = (user) => jwt.sign({ id: user._id.toString() }, config.jwt.secret, { expiresIn: '5m' });

beforeAll(async () => {
    await connectTestDB();
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    jest.clearAllMocks();
});

describe('Hago provider admin routes', () => {
    const providerId = '507f1f77bcf86cd799439011';
    const challengeBody = { phone: '+201234567890', countryCode: '20', deviceId: 'device-12345678' };

    it('rejects unauthenticated and CUSTOMER requests before the Hago connection service is called', async () => {
        const unauthenticated = await requestJson('POST', `/api/admin/providers/${providerId}/hago/login-challenge`, { body: challengeBody });
        const { customer } = await createCustomerWithGroup();
        const customerResponse = await requestJson('POST', `/api/admin/providers/${providerId}/hago/login-challenge`, {
            token: tokenFor(customer), body: challengeBody,
        });

        expect(unauthenticated.status).toBe(401);
        expect(customerResponse.status).toBe(403);
        expect(mockHagoConnectionService.createLoginChallenge).not.toHaveBeenCalled();
    });

    it('allows an authorized SUPERVISOR with MANAGE_SUPPLIERS and returns only the safe service DTO', async () => {
        const supervisor = await createAdmin({ role: 'SUPERVISOR', permissions: ['MANAGE_SUPPLIERS'] });
        mockHagoConnectionService.createLoginChallenge.mockResolvedValue({
            connection: { isPrimary: true, connectionStatus: 'OTP_PENDING', pendingLogin: { status: 'OTP_PENDING', expiresAt: '2030-01-01T00:00:00.000Z' } },
        });

        const response = await requestJson('POST', `/api/admin/providers/${providerId}/hago/login-challenge`, {
            token: tokenFor(supervisor), body: challengeBody,
        });

        expect(response.status).toBe(200);
        expect(mockHagoConnectionService.createLoginChallenge).toHaveBeenCalledWith(providerId, challengeBody);
        expect(JSON.stringify(response.body)).not.toMatch(/\"connectionId\"|\"challengeId\"|\"deviceId\"|\"otp\"|x-client-api-key/i);
    });
});
