import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AvailabilitySlotDto } from './availability-slot.dto';

export class UpdateProviderProfileDto {
  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  postcodeCoverage?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotDto)
  availability?: AvailabilitySlotDto[];
}
