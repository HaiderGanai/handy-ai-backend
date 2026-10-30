import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { PaymentsService } from './payments.service';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('/provider/stripe-account')
  @Roles(Role.PROVIDER)
  async connectStripeAccount(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.connectStripeAccount(req.user.id);
  }

  @Get('/provider/earnings')
  @Roles(Role.PROVIDER)
  async getEarnings(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getEarnings(req.user.id);
  }

  @Get('/user/receipts')
  @Roles(Role.CUSTOMER)
  async getReceipts(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getReceipts(req.user.id);
  }

  @Get('/admin/transactions')
  @Roles(Role.ADMIN)
  async listTransactions(@Query() query: ListTransactionsQueryDto) {
    return this.paymentsService.listTransactions(query);
  }

  @Post('/admin/transactions/:id/payout')
  @Roles(Role.ADMIN)
  async retryPayout(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentsService.retryPayout(id);
  }
}
