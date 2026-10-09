import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AvailabilitySlotDto } from './availability-slot.dto';

export class OnboardProviderDto {
  @IsString()
  bio: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  postcodeCoverage: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  categoryIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotDto)
  availability: AvailabilitySlotDto[];
}
