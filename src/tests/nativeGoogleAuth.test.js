'use strict';

process.env.GOOGLE_CLIENT_ID = 'test-native-google-web-client-id';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const {
    verifyNativeGoogleIdToken,
    loginWithNativeGoogle,
} = require('../modules/auth/googleNativeAuth.service');
const authRoutes = require('../modules/auth/auth.routes');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
} = require('./testHelpers');

const TEST_AUDIENCE = 'test-native-google-web-client-id';

const ticketFor = (payload) => ({
    getPayload: () => payload,
});

const verifiedPayload = (overrides = {}) => ({
    iss: 'https://accounts.google.com',
    aud: TEST_AUDIENCE,
    sub: `google-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    email: `native-google-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    email_verified: true,
    name: 'Native Google User',
    ...overrides,
});

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    mockVerifyIdToken.mockReset();
    await clearCollections();
});

describe('native Google ID-token verification', () => {
    it('verifies a valid, verified Google token using the configured audience', async () => {
        const payload = verifiedPayload();
        mockVerifyIdToken.mockResolvedValue(ticketFor(payload));

        const profile = await verifyNativeGoogleIdToken('valid-google-id-token');

        expect(mockVerifyIdToken).toHaveBeenCalledWith({
            idToken: 'valid-google-id-token',
            audience: TEST_AUDIENCE,
        });
        expect(profile).toEqual({
            id: payload.sub,
            displayName: payload.name,
            emails: [{ value: payload.email }],
        });
    });

    it('rejects an invalid or expired credential at the Google verification boundary', async () => {
        mockVerifyIdToken.mockRejectedValue(new Error('invalid or expired token'));

        await expect(verifyNativeGoogleIdToken('bad-token'))
            .rejects.toMatchObject({ code: 'INVALID_GOOGLE_CREDENTIAL' });
    });

    it('rejects a credential Google rejects as expired', async () => {
        mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));

        await expect(verifyNativeGoogleIdToken('expired-token'))
            .rejects.toMatchObject({ code: 'INVALID_GOOGLE_CREDENTIAL' });
    });

    it('rejects a token whose audience does not match the configured web client', async () => {
        mockVerifyIdToken.mockResolvedValue(ticketFor(verifiedPayload({ aud: 'wrong-client-id' })));

        await expect(verifyNativeGoogleIdToken('wrong-audience-token'))
            .rejects.toMatchObject({ code: 'INVALID_GOOGLE_CREDENTIAL' });
    });

    it('rejects a Google identity whose email is not verified', async () => {
        mockVerifyIdToken.mockResolvedValue(ticketFor(verifiedPayload({ email_verified: false })));

        await expect(verifyNativeGoogleIdToken('unverified-email-token'))
            .rejects.toMatchObject({ code: 'GOOGLE_EMAIL_NOT_VERIFIED' });
    });
});

describe('native Google account and session rules', () => {
    it('logs an existing Google-linked user in through the normal JWT path', async () => {
        const group = await createGroup({ name: 'NativeGoogleExisting' });
        const payload = verifiedPayload();
        const existing = await User.create({
            name: 'Existing Google User',
            email: payload.email,
            googleId: payload.sub,
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            country: 'EG',
            currency: 'USD',
        });
        mockVerifyIdToken.mockResolvedValue(ticketFor(payload));

        const result = await loginWithNativeGoogle({ idToken: 'existing-user-token' });

        expect(result.token).toEqual(expect.any(String));
        expect(result.user._id.toString()).toBe(existing._id.toString());
    });

    it('uses the existing verified-email linking behavior without accepting client roles', async () => {
        const group = await createGroup({ name: 'NativeGoogleEmailLink' });
        const payload = verifiedPayload({ role: ROLES.ADMIN, status: USER_STATUS.REJECTED });
        const existing = await User.create({
            name: 'Email Account',
            email: payload.email,
            password: 'SecurePass@1',
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            country: 'EG',
            currency: 'USD',
        });
        mockVerifyIdToken.mockResolvedValue(ticketFor(payload));

        const result = await loginWithNativeGoogle({
            idToken: 'existing-email-token',
            role: ROLES.ADMIN,
            status: USER_STATUS.REJECTED,
        });
        const linked = await User.findById(existing._id);

        expect(result.token).toEqual(expect.any(String));
        expect(linked.googleId).toBe(payload.sub);
        expect(linked.role).toBe(ROLES.CUSTOMER);
        expect(linked.status).toBe(USER_STATUS.ACTIVE);
    });

    it('creates a new active, verified customer through the shared Google resolver', async () => {
        await createGroup({ name: 'NativeGoogleNew' });
        const payload = verifiedPayload({ role: ROLES.ADMIN, status: USER_STATUS.REJECTED });
        mockVerifyIdToken.mockResolvedValue(ticketFor(payload));

        const result = await loginWithNativeGoogle({ idToken: 'new-user-token' });
        const created = await User.findOne({ googleId: payload.sub });

        expect(result.status).toBe('PROFILE_COMPLETION_REQUIRED');
        expect(created.email).toBe(payload.email);
        expect(created.role).toBe(ROLES.CUSTOMER);
        expect(created.status).toBe(USER_STATUS.ACTIVE);
        expect(created.verified).toBe(true);
    });

    it('preserves pending and rejected account restrictions', async () => {
        const group = await createGroup({ name: 'NativeGoogleRestrictions' });
        const pendingPayload = verifiedPayload();
        await User.create({
            name: 'Pending Google User',
            email: pendingPayload.email,
            googleId: pendingPayload.sub,
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.PENDING,
            verified: true,
            country: 'EG',
            currency: 'USD',
        });
        mockVerifyIdToken.mockResolvedValue(ticketFor(pendingPayload));

        const pendingResult = await loginWithNativeGoogle({ idToken: 'pending-user-token' });
        expect(pendingResult.token).toBeNull();

        const rejectedPayload = verifiedPayload();
        await User.create({
            name: 'Rejected Google User',
            email: rejectedPayload.email,
            googleId: rejectedPayload.sub,
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.REJECTED,
            verified: true,
            country: 'EG',
            currency: 'USD',
        });
        mockVerifyIdToken.mockResolvedValue(ticketFor(rejectedPayload));

        await expect(loginWithNativeGoogle({ idToken: 'rejected-user-token' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    });
});

describe('Google OAuth routes', () => {
    it('keeps browser OAuth routes and exposes the native token exchange route', () => {
        const routePaths = authRoutes.stack
            .filter((layer) => layer.route)
            .map((layer) => ({
                path: layer.route.path,
                methods: layer.route.methods,
            }));

        expect(routePaths).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '/google' }),
            expect.objectContaining({ path: '/google/callback' }),
            expect.objectContaining({ path: '/google/native' }),
        ]));
        expect(routePaths.find((route) => route.path === '/google/native').methods.post).toBe(true);
    });
});
