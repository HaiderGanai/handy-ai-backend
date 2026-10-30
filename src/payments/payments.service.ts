import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { StripeService } from './stripe.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly stripeService: StripeService,
  ) {}

  async createCheckout(
    booking: Pick<Booking, 'id' | 'userId' | 'priceCents'>,
    productName: string,
  ): Promise<string> {
    const customerId = await this.getStripeCustomerId(booking.userId);
    const session = await this.stripeCall(() =>
      this.stripeService.createCheckoutSession({
        customerId,
        amountCents: booking.priceCents,
        productName,
        bookingId: booking.id,
      }),
    );
    return session.url;
  }

  // Frees the customer's card hold. A Stripe failure is logged, not thrown: the booking
  // change stands, the transaction stays HELD for admin visibility and the hold lapses
  // by itself within 7 days.
  async releaseHold(bookingId: string): Promise<void> {
    const transaction = await this.transactionRepository.findOne({
      where: { bookingId },
    });
    if (!transaction || transaction.status !== TransactionStatus.HELD) {
      return;
    }
    try {
      await this.stripeService.cancelPaymentIntent(
        transaction.stripePaymentIntentId,
      );
    } catch (error) {
      this.logger.error(
        `Could not release hold for booking ${bookingId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    await this.transactionRepository.update(
      { id: transaction.id, status: TransactionStatus.HELD },
      { status: TransactionStatus.CANCELLED },
    );
  }

  // Money in on job completion. Capture failure -> 502 (booking stays IN_PROGRESS, provider
  // retries). Payout failure is logged: the money is safely captured and is retried by the
  // next account.updated webhook.
  async captureAndPayout(
    booking: Pick<Booking, 'id' | 'providerId'>,
  ): Promise<void> {
    const transaction = await this.transactionRepository.findOne({
      where: { bookingId: booking.id },
    });
    // bookings created before payments existed have nothing to capture
    if (!transaction) {
      return;
    }
    if (transaction.status === TransactionStatus.HELD) {
      const { chargeId } = await this.stripeCall(() =>
        this.stripeService.capturePaymentIntent(
          transaction.stripePaymentIntentId,
        ),
      );
      await this.transactionRepository.update(transaction.id, {
        status: TransactionStatus.CAPTURED,
        stripeChargeId: chargeId,
      });
      transaction.status = TransactionStatus.CAPTURED;
      transaction.stripeChargeId = chargeId;
    }
    if (transaction.status === TransactionStatus.CAPTURED) {
      await this.tryPayout(transaction, booking.providerId);
    }
  }

  // called when a provider finishes Stripe onboarding: pays everything that was waiting
  async payoutWaiting(providerId: string): Promise<void> {
    const waiting = await this.transactionRepository.find({
      where: {
        status: TransactionStatus.CAPTURED,
        booking: { providerId },
      },
    });
    for (const transaction of waiting) {
      await this.tryPayout(transaction, providerId);
    }
  }

  // a payment that landed on a booking that no longer needs it
  async cancelUnclaimedHold(paymentIntentId: string): Promise<void> {
    await this.stripeCall(() =>
      this.stripeService.cancelPaymentIntent(paymentIntentId),
    );
  }

  // optional, any time: a provider who skipped Stripe at onboarding connects later
  async connectStripeAccount(
    userId: string,
  ): Promise<{ onboardingUrl: string }> {
    const provider = await this.providerRepository.findOne({
      where: { userId },
      relations: { user: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    let accountId = provider.stripeAccountId;
    if (!accountId) {
      accountId = await this.stripeCall(() =>
        this.stripeService.createConnectedAccount(
          provider.user.email,
          provider.id,
        ),
      );
      await this.providerRepository.update(provider.id, {
        stripeAccountId: accountId,
      });
    }
    const connectedAccountId = accountId;
    const onboardingUrl = await this.stripeCall(() =>
      this.stripeService.createAccountLink(connectedAccountId),
    );
    return { onboardingUrl };
  }

  async getEarnings(userId: string) {
    const provider = await this.providerRepository.findOne({
      where: { userId },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    const rows = await this.transactionRepository.find({
      where: { booking: { providerId: provider.id } },
      relations: { booking: { subService: true } },
      order: { createdAt: 'DESC' },
    });
    const live = rows.filter(
      (row) => row.status !== TransactionStatus.CANCELLED,
    );
    const total = (status: TransactionStatus) =>
      live
        .filter((row) => row.status === status)
        .reduce((sum, row) => sum + row.providerPayoutCents, 0);
    return {
      releasedCents: total(TransactionStatus.RELEASED),
      awaitingPayoutCents: total(TransactionStatus.CAPTURED),
      heldCents: total(TransactionStatus.HELD),
      stripeConnected: provider.stripeOnboarded,
      jobs: live.map((row) => ({
        bookingId: row.bookingId,
        serviceName: row.booking.subService.name,
        scheduledAt: row.booking.scheduledAt,
        status: row.status,
        providerPayoutCents: row.providerPayoutCents,
      })),
    };
  }

  async getReceipts(userId: string) {
    const rows = await this.transactionRepository.find({
      where: {
        status: In([TransactionStatus.CAPTURED, TransactionStatus.RELEASED]),
        booking: { userId },
      },
      relations: { booking: { subService: true } },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => ({
      transactionId: row.id,
      bookingId: row.bookingId,
      serviceName: row.booking.subService.name,
      scheduledAt: row.booking.scheduledAt,
      amountCents: row.amountCents,
      createdAt: row.createdAt,
    }));
  }

  async listTransactions(
    query: ListTransactionsQueryDto,
  ): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
    });
  }

  private async tryPayout(
    transaction: Transaction,
    providerId: string,
  ): Promise<void> {
    const provider = await this.providerRepository.findOne({
      where: { id: providerId },
    });
    if (!provider?.stripeAccountId || !provider.stripeOnboarded) {
      return;
    }
    try {
      const transferId = await this.stripeService.createTransfer({
        amountCents: transaction.providerPayoutCents,
        destination: provider.stripeAccountId,
        chargeId: transaction.stripeChargeId!,
        bookingId: transaction.bookingId,
        idempotencyKey: `payout-${transaction.id}`,
      });
      await this.transactionRepository.update(transaction.id, {
        status: TransactionStatus.RELEASED,
        stripeTransferId: transferId,
      });
    } catch (error) {
      this.logger.error(
        `Payout failed for transaction ${transaction.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async getStripeCustomerId(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found!');
    }
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }
    const customerId = await this.stripeCall(() =>
      this.stripeService.createCustomer(user.email, user.id),
    );
    await this.userRepository.update(user.id, { stripeCustomerId: customerId });
    return customerId;
  }

  // Stripe/network failures become a clear 502; our own HTTP errors (e.g. "not configured") pass through
  private async stripeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        'Stripe call failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException(
        'Payment service is unavailable, please retry!',
      );
    }
  }
}
