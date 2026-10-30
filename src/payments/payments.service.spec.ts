import { BadGatewayException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  const txRepo = { findOne: jest.fn(), find: jest.fn(), update: jest.fn() };
  const providerRepo = { findOne: jest.fn(), update: jest.fn() };
  const userRepo = { findOne: jest.fn(), update: jest.fn() };
  const stripe = {
    createCustomer: jest.fn(),
    createCheckoutSession: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    capturePaymentIntent: jest.fn(),
    createTransfer: jest.fn(),
    createConnectedAccount: jest.fn(),
    createAccountLink: jest.fn(),
  };

  const makeTx = (over: object = {}) => ({
    id: 't1',
    bookingId: 'b1',
    stripePaymentIntentId: 'pi_1',
    stripeChargeId: null,
    amountCents: 8000,
    providerPayoutCents: 6400,
    status: TransactionStatus.HELD,
    ...over,
  });
  const connected = {
    id: 'p1',
    stripeAccountId: 'acct_1',
    stripeOnboarded: true,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    txRepo.update.mockResolvedValue({ affected: 1 });
    providerRepo.findOne.mockResolvedValue(connected);
    stripe.capturePaymentIntent.mockResolvedValue({ chargeId: 'ch_1' });
    stripe.createTransfer.mockResolvedValue('tr_1');
    stripe.cancelPaymentIntent.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Transaction), useValue: txRepo },
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: StripeService, useValue: stripe },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  describe('createCheckout', () => {
    const booking = { id: 'b1', userId: 'c1', priceCents: 8000 };

    it('creates the Stripe customer once, stores it and returns the checkout url', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'c1',
        email: 'a@b.c',
        stripeCustomerId: null,
      });
      stripe.createCustomer.mockResolvedValue('cus_1');
      stripe.createCheckoutSession.mockResolvedValue({
        url: 'https://pay.test/s1',
      });

      const url = await service.createCheckout(booking, 'Regular home clean');

      expect(url).toBe('https://pay.test/s1');
      expect(userRepo.update).toHaveBeenCalledWith('c1', {
        stripeCustomerId: 'cus_1',
      });
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith({
        customerId: 'cus_1',
        amountCents: 8000,
        productName: 'Regular home clean',
        bookingId: 'b1',
      });
    });

    it('reuses an existing Stripe customer', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'c1',
        email: 'a@b.c',
        stripeCustomerId: 'cus_old',
      });
      stripe.createCheckoutSession.mockResolvedValue({
        url: 'https://pay.test/s2',
      });
      await service.createCheckout(booking, 'Clean');
      expect(stripe.createCustomer).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_old' }),
      );
    });

    it('answers 502 when Stripe fails', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'c1',
        email: 'a@b.c',
        stripeCustomerId: 'cus_old',
      });
      stripe.createCheckoutSession.mockRejectedValue(new Error('stripe down'));
      await expect(service.createCheckout(booking, 'Clean')).rejects.toThrow(
        BadGatewayException,
      );
    });
  });

  describe('releaseHold', () => {
    it('cancels the PaymentIntent and marks the transaction CANCELLED', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      await service.releaseHold('b1');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(txRepo.update).toHaveBeenCalledWith(
        { id: 't1', status: TransactionStatus.HELD },
        { status: TransactionStatus.CANCELLED },
      );
    });

    it('does nothing without a held transaction', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await service.releaseHold('b1');
      txRepo.findOne.mockResolvedValue(
        makeTx({ status: TransactionStatus.CAPTURED }),
      );
      await service.releaseHold('b1');
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('swallows a Stripe failure and leaves the transaction HELD', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));
      await expect(service.releaseHold('b1')).resolves.toBeUndefined();
      expect(txRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('captureAndPayout', () => {
    const booking = { id: 'b1', providerId: 'p1' };

    it('skips bookings that have no transaction (created before payments existed)', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).not.toHaveBeenCalled();
    });

    it('captures, then pays 80% to a connected provider and marks RELEASED', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(txRepo.update).toHaveBeenNthCalledWith(1, 't1', {
        status: TransactionStatus.CAPTURED,
        stripeChargeId: 'ch_1',
      });
      expect(stripe.createTransfer).toHaveBeenCalledWith({
        amountCents: 6400,
        destination: 'acct_1',
        chargeId: 'ch_1',
        bookingId: 'b1',
        idempotencyKey: 'payout-t1',
      });
      expect(txRepo.update).toHaveBeenNthCalledWith(2, 't1', {
        status: TransactionStatus.RELEASED,
        stripeTransferId: 'tr_1',
      });
    });

    it('captures but keeps the money when the provider has not connected Stripe', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeAccountId: null,
        stripeOnboarded: false,
      });
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).toHaveBeenCalled();
      expect(stripe.createTransfer).not.toHaveBeenCalled();
      expect(txRepo.update).toHaveBeenCalledTimes(1);
    });

    it('answers 502 and changes nothing when the capture fails', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.capturePaymentIntent.mockRejectedValue(new Error('card declined'));
      await expect(service.captureAndPayout(booking)).rejects.toThrow(
        BadGatewayException,
      );
      expect(txRepo.update).not.toHaveBeenCalled();
    });

    it('keeps the transaction CAPTURED when only the transfer fails', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.createTransfer.mockRejectedValue(new Error('transfer failed'));
      await expect(service.captureAndPayout(booking)).resolves.toBeUndefined();
      expect(txRepo.update).toHaveBeenCalledTimes(1); // the CAPTURED write only
    });

    it('never captures twice: a retry on a CAPTURED transaction only pays out', async () => {
      txRepo.findOne.mockResolvedValue(
        makeTx({ status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_1' }),
      );
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).not.toHaveBeenCalled();
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ chargeId: 'ch_1' }),
      );
    });
  });

  describe('payoutWaiting', () => {
    it('pays out every CAPTURED transaction of the provider', async () => {
      txRepo.find.mockResolvedValue([
        makeTx({
          id: 't1',
          status: TransactionStatus.CAPTURED,
          stripeChargeId: 'ch_1',
        }),
        makeTx({
          id: 't2',
          bookingId: 'b2',
          status: TransactionStatus.CAPTURED,
          stripeChargeId: 'ch_2',
        }),
      ]);
      await service.payoutWaiting('p1');
      expect(stripe.createTransfer).toHaveBeenCalledTimes(2);
      expect(txRepo.update).toHaveBeenCalledWith('t2', {
        status: TransactionStatus.RELEASED,
        stripeTransferId: 'tr_1',
      });
    });

    it('does nothing while the provider is not connected', async () => {
      txRepo.find.mockResolvedValue([
        makeTx({ status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_1' }),
      ]);
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeAccountId: null,
        stripeOnboarded: false,
      });
      await service.payoutWaiting('p1');
      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });
  });

  describe('cancelUnclaimedHold', () => {
    it('cancels the PaymentIntent', async () => {
      await service.cancelUnclaimedHold('pi_9');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_9');
    });
  });
});
