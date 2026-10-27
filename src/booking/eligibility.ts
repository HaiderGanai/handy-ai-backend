import { BadRequestException } from '@nestjs/common';

export interface EligibilityContext {
  categoryId: string;
  postcode: string;
  scheduledAt: Date;
  durationMinutes: number;
  excludeBookingId?: string;
}

const normalisePostcode = (postcode: string) =>
  postcode.replace(/\s+/g, '').toUpperCase();

// 'HH:mm' or 'HH:mm:ss' -> minutes since midnight
const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export function coversPostcode(coverage: string[], postcode: string): boolean {
  const wanted = normalisePostcode(postcode);
  return coverage.some((entry) => normalisePostcode(entry) === wanted);
}

// ponytail: compared in UTC (windows carry no timezone); per-provider timezone later
export function isWithinAvailability(
  slots: { dayOfWeek: number; startTime: string; endTime: string }[],
  start: Date,
  durationMinutes: number,
): boolean {
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = startMinutes + durationMinutes;
  if (endMinutes > 24 * 60) {
    return false;
  }
  return slots.some(
    (slot) =>
      slot.dayOfWeek === start.getUTCDay() &&
      toMinutes(slot.startTime) <= startMinutes &&
      endMinutes <= toMinutes(slot.endTime),
  );
}

export function overlaps(
  aStart: Date,
  aMinutes: number,
  bStart: Date,
  bMinutes: number,
): boolean {
  const aEnd = aStart.getTime() + aMinutes * 60_000;
  const bEnd = bStart.getTime() + bMinutes * 60_000;
  return aStart.getTime() < bEnd && bStart.getTime() < aEnd;
}

export function assertInFuture(date: Date): void {
  if (date.getTime() <= Date.now()) {
    throw new BadRequestException('Booking time must be in the future!');
  }
}
