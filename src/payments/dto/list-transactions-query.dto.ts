import { IsEnum, IsOptional } from 'class-validator';
import { TransactionStatus } from '../enums/transaction-status.enum';

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}
