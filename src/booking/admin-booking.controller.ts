import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../user/enums/role.enum';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { ReassignBookingDto } from './dto/reassign-booking.dto';
import { AdminBookingService } from './services/admin-booking.service';

@Controller('admin/bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class AdminBookingController {
  constructor(private readonly adminBookingService: AdminBookingService) {}

  @Get()
  async listBookings(@Query() query: ListBookingsQueryDto) {
    return this.adminBookingService.listBookings(query);
  }

  @Post('/:id/reassign')
  async reassignBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReassignBookingDto,
  ) {
    return this.adminBookingService.reassignBooking(id, body);
  }
}
