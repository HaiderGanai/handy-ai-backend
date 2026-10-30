import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Stripe from 'stripe';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Provider } from '../provider/entities/provider.entity';
import { Transaction } from './entities/transaction.entity';
import { splitAmount } from './money';
import { PaymentsService } from './payments.service';
import { isPayoutReady, StripeService } from './stripe.service';

@Injectable()
export class StripeWebhookService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Stripe redelivers, so every handler checks current state first and is safe to repeat
  async handleStripeWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<{ received: true }> {
    const event = this.stripeService.constructEvent(rawBody, signature);
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object);
        break;
      case 'checkout.session.expired':
        await this.onCheckoutExpired(event.data.object);
        break;
      case 'account.updated':
        await this.onAccountUpdated(event.data.object);
        break;
    }
    return { received: true };
  }

  private async onCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const bookingId = session.client_reference_id;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!bookingId || !paymentIntentId) {
      return;
    }
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: { provider: true },
    });
    const existing = await this.transactionRepository.findOne({
      where: { bookingId },
    });
    // the customer paid a second checkout link for the same booking: refund that hold
    if (existing && existing.stripePaymentIntentId !== paymentIntentId) {
      await this.paymentsService.cancelUnclaimedHold(paymentIntentId);
      return;
    }
    if (!existing) {
      // paid for a booking that was cancelled/expired meanwhile: give the hold back
      if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) {
        await this.paymentsService.cancelUnclaimedHold(paymentIntentId);
        return;
      }
      const { commissionCents, providerPayoutCents } = splitAmount(
        booking.priceCents,
      );
      // ponytail: a cancel racing between the check above and the flip below leaves a stray hold;
      // it lapses within 7 days
      await this.transactionRepository.save(
        this.transactionRepository.create({
          bookingId,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          amountCents: booking.priceCents,
          commissionCents,
          providerPayoutCents,
        }),
      );
    }
    // repeating this on a redelivery is harmless: the compare-and-set matches nothing
    const { affected } = await this.bookingRepository.update(
      { id: bookingId, status: BookingStatus.PENDING_PAYMENT },
      { status: BookingStatus.PENDING_PROVIDER },
    );
    if (affected && booking) {
      this.notificationsService.notify(
        booking.provider.userId,
        'BOOKING_REQUESTED',
        { bookingId },
      );
    }
  }

  private async onCheckoutExpired(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const bookingId = session.client_reference_id;
    if (!bookingId) {
      return;
    }
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });
    // an older link expiring must not cancel a booking that has a newer one open
    if (
      booking?.status !== BookingStatus.PENDING_PAYMENT ||
      (booking.checkoutSessionId && booking.checkoutSessionId !== session.id)
    ) {
      return;
    }
    const { affected } = await this.bookingRepository.update(
      { id: bookingId, status: BookingStatus.PENDING_PAYMENT },
      { status: BookingStatus.CANCELLED },
    );
    if (affected) {
      this.notificationsService.notify(
        booking.userId,
        'BOOKING_PAYMENT_EXPIRED',
        { bookingId },
      );
    }
  }

  private async onAccountUpdated(account: Stripe.Account): Promise<void> {
    const provider = await this.providerRepository.findOne({
      where: { stripeAccountId: account.id },
    });
    if (!provider) {
      return;
    }
    const ready = isPayoutReady(account);
    // follows Stripe both ways: a restricted account stops receiving transfers
    if (provider.stripeOnboarded !== ready) {
      await this.providerRepository.update(provider.id, {
        stripeOnboarded: ready,
      });
    }
    if (!ready) {
      return;
    }
    // also retries payouts that failed earlier
    await this.paymentsService.payoutWaiting(provider.id);
  }
}
