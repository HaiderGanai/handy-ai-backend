export const COMMISSION_PERCENT = 20;

// integer cents only; the commission rounds down so commission + payout === amount
export function splitAmount(amountCents: number): {
  commissionCents: number;
  providerPayoutCents: number;
} {
  const commissionCents = Math.floor((amountCents * COMMISSION_PERCENT) / 100);
  return {
    commissionCents,
    providerPayoutCents: amountCents - commissionCents,
  };
}
