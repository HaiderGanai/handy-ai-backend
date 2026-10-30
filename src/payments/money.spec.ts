import { splitAmount } from './money';

describe('splitAmount', () => {
  it('takes 20% commission and pays the rest to the provider', () => {
    expect(splitAmount(8000)).toEqual({
      commissionCents: 1600,
      providerPayoutCents: 6400,
    });
  });

  it('rounds the commission down so the two parts always add up exactly', () => {
    const { commissionCents, providerPayoutCents } = splitAmount(999);
    expect(commissionCents).toBe(199);
    expect(providerPayoutCents).toBe(800);
    expect(commissionCents + providerPayoutCents).toBe(999);
  });
});
