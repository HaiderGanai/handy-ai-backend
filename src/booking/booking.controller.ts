import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { PlanBookingDto } from './dto/plan-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { BookingPlanService } from './services/booking-plan.service';
import { BookingService } from './services/booking.service';

@Controller('bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly bookingPlanService: BookingPlanService,
  ) {}

  @Post('/plan')
  @Roles(Role.CUSTOMER)
  async planBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: PlanBookingDto,
  ) {
    return this.bookingPlanService.planBooking(req.user.id, body);
  }

  @Post()
  @Roles(Role.CUSTOMER)
  async createBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateBookingDto,
  ) {
    return this.bookingService.createBooking(req.user.id, body);
  }

  @Post('/:id/checkout')
  @Roles(Role.CUSTOMER)
  async createBookingCheckout(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.createBookingCheckout(req.user.id, id);
  }

  @Get()
  @Roles(Role.CUSTOMER, Role.PROVIDER)
  async listBookings(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.bookingService.listBookings(req.user.id, req.user.role, query);
  }

  // declared before '/:id' so "in-progress" isn't parsed as a booking id
  @Get('/in-progress')
  @Roles(Role.CUSTOMER, Role.PROVIDER)
  async listInProgressBookings(@Req() req: AuthenticatedRequest) {
    return this.bookingService.listInProgressBookings(
      req.user.id,
      req.user.role,
    );
  }

  @Get('/:id')
  @Roles(Role.CUSTOMER, Role.PROVIDER, Role.ADMIN)
  async getBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.getBooking(req.user.id, req.user.role, id);
  }

  @Patch('/:id')
  @Roles(Role.CUSTOMER)
  async updateBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBookingDto,
  ) {
    return this.bookingService.updateBooking(req.user.id, id, body);
  }

  @Delete('/:id')
  @Roles(Role.CUSTOMER)
  async cancelBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.cancelBooking(req.user.id, id);
  }

  @Post('/:id/accept')
  @Roles(Role.PROVIDER)
  async acceptBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.acceptBooking(req.user.id, id);
  }

  @Post('/:id/decline')
  @Roles(Role.PROVIDER)
  async declineBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.declineBooking(req.user.id, id);
  }

  @Post('/:id/start')
  @Roles(Role.PROVIDER)
  async startBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.startBooking(req.user.id, id);
  }

  @Post('/:id/complete')
  @Roles(Role.PROVIDER)
  async completeBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.completeBooking(req.user.id, id);
  }
}
