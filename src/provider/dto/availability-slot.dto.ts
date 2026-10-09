import { IsInt, Matches, Max, Min } from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class AvailabilitySlotDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @Matches(TIME_PATTERN, { message: 'startTime must be HH:mm' })
  startTime: string;

  @Matches(TIME_PATTERN, { message: 'endTime must be HH:mm' })
  endTime: string;
}
