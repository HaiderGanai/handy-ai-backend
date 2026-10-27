import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { PlanBookingDto } from './dto/plan-booking.dto';
import { BookingPlanService } from './services/booking-plan.service';

@Controller('bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class BookingController {
  constructor(private readonly bookingPlanService: BookingPlanService) {}

  @Post('/plan')
  @Roles(Role.CUSTOMER)
  async planBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: PlanBookingDto,
  ) {
    return this.bookingPlanService.planBooking(req.user.id, body);
  }
}
