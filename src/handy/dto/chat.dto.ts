import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsTimeZone,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChatDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message: string;

  // IANA name from the device, e.g. Asia/Karachi; UTC when omitted
  @IsOptional()
  @IsTimeZone()
  timezone?: string;
}
