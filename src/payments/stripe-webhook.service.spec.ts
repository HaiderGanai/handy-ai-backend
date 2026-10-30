import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type Stripe from 'stripe';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Provider } from '../provider/entities/provider.entity';
import { Transaction } from './entities/transaction.entity';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';
import { StripeWebhookService } from './stripe-webhook.service';

const event = (type: string, object: object) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;
  const bookingRepo = { findOne: jest.fn(), update: jest.fn() };
  const txRepo = {
    findOne: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const providerRepo = { findOne: jest.fn(), update: jest.fn() };
  const stripe = { constructEvent: jest.fn() };
  const payments = { payoutWaiting: jest.fn(), cancelUnclaimedHold: jest.fn() };
  const notifications = { notify: jest.fn() };

  const session = {
    id: 'cs_1',
    client_reference_id: 'b1',
    payment_intent: 'pi_1',
  };
  const pendingBooking = {
    id: 'b1',
    userId: 'c1',
    priceCents: 8000,
    status: BookingStatus.PENDING_PAYMENT,
    provider: { userId: 'pu1' },
  };

  const send = (e: Stripe.Event) => {
    stripe.constructEvent.mockReturnValue(e);
    return service.handleStripeWebhook(Buffer.from('{}'), 'sig');
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    bookingRepo.findOne.mockResolvedValue(pendingBooking);
    bookingRepo.update.mockResolvedValue({ affected: 1 });
    txRepo.findOne.mockResolvedValue(null);
    const module = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: getRepositoryToken(Transaction), useValue: txRepo },
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: StripeService, useValue: stripe },
        { provide: PaymentsService, useValue: payments },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(StripeWebhookService);
  });

  it('rejects an invalid signature', async () => {
    stripe.constructEvent.mockImplementation(() => {
      throw new BadRequestException('Invalid Stripe signature!');
    });
    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'bad'),
    ).rejects.toThrow(BadRequestException);
  });

  it('ignores event types it does not handle', async () => {
    await expect(send(event('customer.created', {}))).resolves.toEqual({
      received: true,
    });
    expect(bookingRepo.update).not.toHaveBeenCalled();
  });

  describe('checkout.session.completed', () => {
    it('records the held payment, hands the booking to the provider and notifies them', async () => {
      await send(event('checkout.session.completed', session));
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'b1',
          stripeCheckoutSessionId: 'cs_1',
          stripePaymentIntentId: 'pi_1',
          amountCents: 8000,
          commissionCents: 1600,
          providerPayoutCents: 6400,
        }),
      );
      expect(bookingRepo.update).toHaveBeenCalledWith(
        { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
        { status: BookingStatus.PENDING_PROVIDER },
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'pu1',
        'BOOKING_REQUESTED',
        { bookingId: 'b1' },
      );
    });

    it('on redelivery makes no second transaction and no second notification', async () => {
      txRepo.findOne.mockResolvedValue({ id: 't1' });
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.PENDING_PROVIDER,
      });
      bookingRepo.update.mockResolvedValue({ affected: 0 });
      await send(event('checkout.session.completed', session));
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(payments.cancelUnclaimedHold).not.toHaveBeenCalled();
    });

    it('cancels the hold when the booking was cancelled or expired meanwhile', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.CANCELLED,
      });
      await send(event('checkout.session.completed', session));
      expect(payments.cancelUnclaimedHold).toHaveBeenCalledWith('pi_1');
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('cancels the hold when the booking no longer exists', async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await send(event('checkout.session.completed', session));
      expect(payments.cancelUnclaimedHold).toHaveBeenCalledWith('pi_1');
    });

    it('ignores sessions that are not ours (no booking reference)', async () => {
      await send(
        event('checkout.session.completed', {
          ...session,
          client_reference_id: null,
        }),
      );
      expect(bookingRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('checkout.session.expired', () => {
    it('cancels an unpaid booking and tells the customer', async () => {
      await send(event('checkout.session.expired', session));
      expect(bookingRepo.update).toHaveBeenCalledWith(
        { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
        { status: BookingStatus.CANCELLED },
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'c1',
        'BOOKING_PAYMENT_EXPIRED',
        { bookingId: 'b1' },
      );
    });

    it('leaves a booking that is no longer waiting for payment alone', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.CONFIRMED,
      });
      await send(event('checkout.session.expired', session));
      expect(bookingRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('account.updated', () => {
    const ready = {
      id: 'acct_1',
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
    };

    it('marks the provider onboarded and pays out what was waiting', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeOnboarded: false,
      });
      await send(event('account.updated', ready));
      expect(providerRepo.update).toHaveBeenCalledWith('p1', {
        stripeOnboarded: true,
      });
      expect(payments.payoutWaiting).toHaveBeenCalledWith('p1');
    });

    it('does not pay out while the account is not ready', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeOnboarded: false,
      });
      await send(
        event('account.updated', { ...ready, payouts_enabled: false }),
      );
      expect(providerRepo.update).not.toHaveBeenCalled();
      expect(payments.payoutWaiting).not.toHaveBeenCalled();
    });

    it('ignores accounts that belong to no provider', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      await send(event('account.updated', ready));
      expect(payments.payoutWaiting).not.toHaveBeenCalled();
    });
  });
});
