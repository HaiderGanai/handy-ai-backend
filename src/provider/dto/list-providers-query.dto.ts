import { IsEnum, IsOptional } from 'class-validator';
import { ProviderStatus } from '../enums/provider-status.enum';

export class ListProvidersQueryDto {
  @IsOptional()
  @IsEnum(ProviderStatus)
  status?: ProviderStatus;
}
