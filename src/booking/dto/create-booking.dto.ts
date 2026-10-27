import { IsUUID } from 'class-validator';
import { PlanBookingDto } from './plan-booking.dto';

export class CreateBookingDto extends PlanBookingDto {
  @IsUUID()
  providerId: string;
}
