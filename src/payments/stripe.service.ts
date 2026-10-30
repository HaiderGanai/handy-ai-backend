import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

// payouts need the account's payouts switched on and the `transfers` capability active
export function isPayoutReady(
  account: Pick<Stripe.Account, 'payouts_enabled' | 'capabilities'>,
): boolean {
  return (
    account.payouts_enabled === true &&
    account.capabilities?.transfers === 'active'
  );
}

// The only file that talks to Stripe. Everything else mocks this class in tests.
@Injectable()
export class StripeService {
  private stripe?: Stripe;

  constructor(private readonly config: ConfigService) {}

  async createCustomer(email: string, userId: string): Promise<string> {
    const customer = await this.client().customers.create({
      email,
      metadata: { userId },
    });
    return customer.id;
  }

  // card is authorised only (capture_method manual) and saved for the customer's next booking
  async createCheckoutSession(p: {
    customerId: string;
    amountCents: number;
    productName: string;
    bookingId: string;
  }): Promise<{ url: string }> {
    const session = await this.client().checkout.sessions.create({
      mode: 'payment',
      customer: p.customerId,
      client_reference_id: p.bookingId,
      // Stripe's minimum is 30 minutes from now
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: this.required('STRIPE_SUCCESS_URL'),
      cancel_url: this.required('STRIPE_CANCEL_URL'),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: p.amountCents,
            product_data: { name: p.productName },
          },
        },
      ],
      payment_intent_data: {
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        transfer_group: `booking_${p.bookingId}`,
        metadata: { bookingId: p.bookingId },
      },
    });
    if (!session.url) {
      throw new Error('Stripe returned a Checkout Session without a url');
    }
    return { url: session.url };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    await this.client().paymentIntents.cancel(id);
  }

  async capturePaymentIntent(id: string): Promise<{ chargeId: string }> {
    const intent = await this.client().paymentIntents.capture(id);
    const charge = intent.latest_charge;
    const chargeId = typeof charge === 'string' ? charge : charge?.id;
    if (!chargeId) {
      throw new Error(`PaymentIntent ${id} was captured without a charge`);
    }
    return { chargeId };
  }

  // source_transaction ties the payout to the captured charge, so it works
  // before those funds reach the platform's available balance
  async createTransfer(p: {
    amountCents: number;
    destination: string;
    chargeId: string;
    bookingId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const transfer = await this.client().transfers.create(
      {
        amount: p.amountCents,
        currency: 'usd',
        destination: p.destination,
        source_transaction: p.chargeId,
        transfer_group: `booking_${p.bookingId}`,
        metadata: { bookingId: p.bookingId },
      },
      { idempotencyKey: p.idempotencyKey },
    );
    return transfer.id;
  }

  async createConnectedAccount(
    email: string,
    providerId: string,
  ): Promise<string> {
    const account = await this.client().accounts.create({
      type: 'express',
      country: 'US',
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { providerId },
    });
    return account.id;
  }

  async createAccountLink(accountId: string): Promise<string> {
    const link = await this.client().accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: this.required('STRIPE_CANCEL_URL'),
      return_url: this.required('STRIPE_SUCCESS_URL'),
    });
    return link.url;
  }

  // verifying a signature needs no API key, so any placeholder key will do
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.required('STRIPE_WEBHOOK_SECRET');
    try {
      return new Stripe('sk_test_unused').webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe signature!');
    }
  }

  private client(): Stripe {
    this.stripe ??= new Stripe(this.required('STRIPE_SECRET_KEY'));
    return this.stripe;
  }

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new ServiceUnavailableException('Payments are not configured!');
    }
    return value;
  }
}
