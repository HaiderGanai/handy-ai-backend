import { IsUUID } from 'class-validator';

export class ReassignBookingDto {
  @IsUUID()
  providerId: string;
}
