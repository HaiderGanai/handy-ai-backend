import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Transaction } from './entities/transaction.entity';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, Booking, Provider, User]),
    NotificationsModule,
  ],
  controllers: [StripeWebhookController],
  providers: [PaymentsService, StripeService, StripeWebhookService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
