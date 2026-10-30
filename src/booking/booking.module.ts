import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubService } from '../catalog/entities/sub-service.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { AdminBookingController } from './admin-booking.controller';
import { BookingController } from './booking.controller';
import { Booking } from './entities/booking.entity';
import { TrustedProvider } from './entities/trusted-provider.entity';
import { TrustedProviderController } from './trusted-provider.controller';
import { AdminBookingService } from './services/admin-booking.service';
import { BookingPlanService } from './services/booking-plan.service';
import { BookingService } from './services/booking.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      TrustedProvider,
      Provider,
      SubService,
      User,
    ]),
    NotificationsModule,
    PaymentsModule,
  ],
  controllers: [
    BookingController,
    TrustedProviderController,
    AdminBookingController,
  ],
  providers: [BookingPlanService, BookingService, AdminBookingService],
})
export class BookingModule {}
