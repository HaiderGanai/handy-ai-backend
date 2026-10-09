import { IsOptional, IsString } from 'class-validator';

export class RejectProviderDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
