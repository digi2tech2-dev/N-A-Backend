'use strict';

const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { debitExactWalletAtomic, creditExactWalletAtomic, refundExactWalletAtomic } = require('../modules/wallet/exactLedger.service');
const { decimalStringToUnits } = require('../shared/utils/exactLedgerMoney');
const walletService = require('../modules/wallet/wallet.service');
const walletController = require('../modules/wallet/wallet.controller');
const meController = require('../modules/me/me.controller');
const userService = require('../modules/users/user.service');
const adminUserService = require('../modules/admin/admin.users.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const adminOrderService = require('../modules/admin/admin.orders.service');
const { createOrder, getOrderById, listOrdersForUser } = require('../modules/orders/order.service');
const { mapCreatedOrder } = require('../modules/clientCompat/clientCompat.mappers');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);

const originalExactLedgerEnabled = process.env.EXACT_LEDGER_ENABLED;
beforeEach(async () => {
    await clearCollections();
    delete process.env.EXACT_LEDGER_ENABLED;
});
afterAll(() => {
    if (originalExactLedgerEnabled === undefined) delete process.env.EXACT_LEDGER_ENABLED;
    else process.env.EXACT_LEDGER_ENABLED = originalExactLedgerEnabled;
});

const invoke = (handler, req) => new Promise((resolve, reject) => {
    const res = {
        status() { return this; },
        json(payload) { resolve(payload); },
    };
    handler(req, res, reject);
});

describe('exact ledger read compatibility', () => {
    test('returns exact strings for customer/admin wallet, history, and stats reads', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({
            groupId: group._id,
            walletBalance: 0,
            creditLimit: 1,
            creditUsed: 0,
        });
        const micro = '0.0000000000001';

        await debitExactWalletAtomic({ userId: customer._id, decimal: micro, description: 'micro debit' });
        const debitedWallet = await invoke(meController.getWallet, { user: { _id: customer._id } });
        expect(debitedWallet.data).toMatchObject({
            walletBalance: `-${micro}`,
            creditLimit: '1',
            creditUsed: micro,
            availableBalance: '0.9999999999999',
            availableCredit: '0.9999999999999',
        });
        expect(debitedWallet.data.recentTransactions[0]).not.toHaveProperty('amountUnits');

        await creditExactWalletAtomic({ userId: customer._id, decimal: micro, description: 'micro credit' });
        await refundExactWalletAtomic({ userId: customer._id, units: decimalStringToUnits(micro), description: 'micro refund' });

        const profile = await userService.getMyProfile(customer._id);
        expect(profile).toMatchObject({
            walletBalance: micro,
            creditLimit: '1',
            creditUsed: '0',
        });
        expect(profile).not.toHaveProperty('walletBalanceUnits');

        const adminUser = await adminUserService.getUserById(customer._id);
        expect(adminUser.walletBalance).toBe(micro);
        expect(adminUser).not.toHaveProperty('walletBalanceUnits');

        const history = await walletService.getTransactionHistory(customer._id);
        expect(history.transactions).toHaveLength(3);
        const refund = history.transactions.find((transaction) => transaction.type === 'REFUND');
        expect(refund).toMatchObject({
            amount: micro,
            balanceBefore: '0',
            balanceAfter: micro,
        });
        expect(refund).not.toHaveProperty('amountUnits');

        const adminWallet = await adminWalletService.getWallet(customer._id);
        expect(adminWallet.user).toMatchObject({
            walletBalance: micro,
            creditLimit: '1',
            creditUsed: '0',
            availableBalance: '1.0000000000001',
            availableCredit: '1',
        });
        expect(adminWallet.recentTransactions[0]).not.toHaveProperty('balanceAfterUnits');

        const walletStats = await invoke(walletController.getMyWalletStats, { user: { _id: customer._id } });
        expect(walletStats.data).toMatchObject({
            totalDeposits: micro,
            totalSpent: micro,
            totalRefunds: micro,
            netBalance: micro,
            totalTransactions: 3,
        });

        const meProfile = await invoke(meController.getProfile, { user: { _id: customer._id } });
        expect(meProfile.data.walletBalance).toBe(micro);
        expect(meProfile.data.availableBalance).toBe('1.0000000000001');
    });

    test('returns exact order charge splits and preserves client compatibility micro prices', async () => {
        process.env.EXACT_LEDGER_ENABLED = 'true';
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 1 });
        const micro = '0.0000000000001';
        const product = await createProduct({ basePrice: micro, minQty: 1, maxQty: 1, executionType: 'manual' });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: `exact-read:${customer._id}`,
        });

        const [listed] = (await listOrdersForUser(customer._id)).orders;
        expect(listed).toMatchObject({
            chargedAmount: micro,
            walletDeducted: micro,
            creditUsedAmount: '0',
            totalPrice: micro,
        });
        expect(listed).not.toHaveProperty('chargedAmountUnits');

        const detail = await getOrderById(order._id, customer._id);
        expect(detail.chargedAmount).toBe(micro);
        expect(detail.walletDeducted).toBe(micro);
        expect(detail).not.toHaveProperty('walletDeductedUnits');

        const adminDetail = await adminOrderService.getOrderById(order._id);
        expect(adminDetail.chargedAmount).toBe(micro);
        expect(adminDetail.walletDeducted).toBe(micro);

        expect(mapCreatedOrder({
            compatOrderId: 'exact-compat',
            status: 'PENDING',
            chargedAmountUnits: decimalStringToUnits(micro),
        }).price).toBe(micro);
    });

    test('keeps gate-off wallet and client compatibility response types unchanged', async () => {
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 1 });
        await WalletTransaction.create({
            userId: customer._id,
            type: 'CREDIT',
            amount: 0.01,
            balanceBefore: 1,
            balanceAfter: 1.01,
            description: 'legacy credit',
        });

        const profile = await userService.getMyProfile(customer._id);
        const history = await walletService.getTransactionHistory(customer._id);
        expect(typeof profile.walletBalance).toBe('number');
        expect(typeof history.transactions[0].amount).toBe('number');
        expect(mapCreatedOrder({ compatOrderId: 'legacy-compat', status: 'PENDING', chargedAmount: 0.0000001 }).price).toBe(0);
    });
});
