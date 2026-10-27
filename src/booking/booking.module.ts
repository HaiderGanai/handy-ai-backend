import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubService } from '../catalog/entities/sub-service.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { BookingController } from './booking.controller';
import { Booking } from './entities/booking.entity';
import { TrustedProvider } from './entities/trusted-provider.entity';
import { BookingPlanService } from './services/booking-plan.service';

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
  ],
  controllers: [BookingController],
  providers: [BookingPlanService],
})
export class BookingModule {}
