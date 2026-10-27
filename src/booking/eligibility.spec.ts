import { BadRequestException } from '@nestjs/common';
import {
  assertInFuture,
  coversPostcode,
  isWithinAvailability,
  overlaps,
} from './eligibility';

describe('eligibility helpers', () => {
  // 2030-01-07 is a Monday (dayOfWeek 1)
  const monday = (time: string) => new Date(`2030-01-07T${time}:00Z`);
  const slot = { dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' };

  it('matches postcodes ignoring case and spaces', () => {
    expect(coversPostcode(['SW1A 1AA'], 'sw1a1aa')).toBe(true);
    expect(coversPostcode(['SW1A 1AA'], 'SW1A 2AA')).toBe(false);
  });

  it('requires the whole job inside one availability window', () => {
    expect(isWithinAvailability([slot], monday('10:00'), 60)).toBe(true);
    expect(isWithinAvailability([slot], monday('16:30'), 60)).toBe(false);
    expect(isWithinAvailability([slot], monday('08:30'), 60)).toBe(false);
    expect(
      isWithinAvailability([slot], new Date('2030-01-08T10:00:00Z'), 60),
    ).toBe(false);
  });

  it('rejects a job that runs past midnight', () => {
    const wide = { dayOfWeek: 1, startTime: '00:00:00', endTime: '23:59:00' };
    expect(isWithinAvailability([wide], monday('23:30'), 60)).toBe(false);
  });

  it('treats back-to-back bookings as non-overlapping', () => {
    expect(overlaps(monday('10:00'), 60, monday('11:00'), 60)).toBe(false);
    expect(overlaps(monday('10:00'), 60, monday('10:30'), 60)).toBe(true);
  });

  it('rejects dates in the past', () => {
    expect(() => assertInFuture(new Date('2000-01-01T00:00:00Z'))).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertInFuture(new Date('2999-01-01T00:00:00Z')),
    ).not.toThrow();
  });
});
