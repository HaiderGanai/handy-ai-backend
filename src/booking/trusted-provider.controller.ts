import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { BookingService } from './services/booking.service';

@Controller('user/trusted-providers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.CUSTOMER)
export class TrustedProviderController {
  constructor(private readonly bookingService: BookingService) {}

  @Post('/:providerId')
  async addTrustedProvider(
    @Req() req: AuthenticatedRequest,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ) {
    return this.bookingService.addTrustedProvider(req.user.id, providerId);
  }
}
