import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { isPayoutReady, StripeService } from './stripe.service';

const SECRET = 'whsec_test_secret';
const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('StripeService', () => {
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'account.updated',
    data: { object: { id: 'acct_1' } },
  });
  const sign = (secret = SECRET) =>
    new Stripe('sk_test_unused').webhooks.generateTestHeaderString({
      payload,
      secret,
    });

  it('accepts a correctly signed webhook payload', () => {
    const service = new StripeService(
      config({ STRIPE_WEBHOOK_SECRET: SECRET }),
    );
    const event = service.constructEvent(Buffer.from(payload), sign());
    expect(event.type).toBe('account.updated');
  });

  it('rejects a payload signed with another secret with 400', () => {
    const service = new StripeService(
      config({ STRIPE_WEBHOOK_SECRET: SECRET }),
    );
    expect(() =>
      service.constructEvent(Buffer.from(payload), sign('whsec_other')),
    ).toThrow(BadRequestException);
  });

  it('answers 503 when the webhook secret is not configured', () => {
    const service = new StripeService(config({}));
    expect(() => service.constructEvent(Buffer.from(payload), sign())).toThrow(
      ServiceUnavailableException,
    );
  });

  it('answers 503 on API calls when the secret key is not configured', async () => {
    const service = new StripeService(config({}));
    await expect(service.cancelPaymentIntent('pi_1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('isPayoutReady', () => {
  it('needs payouts enabled and the transfers capability active', () => {
    expect(
      isPayoutReady({
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
      }),
    ).toBe(true);
    expect(
      isPayoutReady({
        payouts_enabled: true,
        capabilities: { transfers: 'pending' },
      }),
    ).toBe(false);
    expect(
      isPayoutReady({
        payouts_enabled: false,
        capabilities: { transfers: 'active' },
      }),
    ).toBe(false);
    expect(isPayoutReady({ payouts_enabled: true })).toBe(false);
  });
});
