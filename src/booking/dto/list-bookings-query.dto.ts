import { IsEnum, IsOptional } from 'class-validator';
import { BookingStatus } from '../enums/booking-status.enum';

export class ListBookingsQueryDto {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}
