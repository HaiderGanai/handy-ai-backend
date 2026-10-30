export enum BookingStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PENDING_PROVIDER = 'PENDING_PROVIDER',
  CONFIRMED = 'CONFIRMED',
  DECLINED = 'DECLINED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

// statuses that hold a provider's time slot
export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING_PAYMENT, // customer has not paid yet; invisible to providers
  BookingStatus.PENDING_PROVIDER,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
];
