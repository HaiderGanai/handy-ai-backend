export enum TransactionStatus {
  HELD = 'HELD', // card authorised, not yet captured
  CAPTURED = 'CAPTURED', // captured; provider payout still waiting
  RELEASED = 'RELEASED', // provider paid
  CANCELLED = 'CANCELLED', // hold released, nothing charged
}
