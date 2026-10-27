import { Type } from 'class-transformer';
import {
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class PlanBookingDto {
  @IsUUID()
  subServiceId: string;

  @Type(() => Date)
  @IsDate()
  scheduledAt: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
