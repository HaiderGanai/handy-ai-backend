import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingModule } from '../booking/booking.module';
import { CatalogModule } from '../catalog/catalog.module';
import { HandyMessage } from './entities/handy-message.entity';
import { User } from '../user/entities/user.entity';
import { HandyChatService } from './handy-chat.service';
import { HandyController } from './handy.controller';
import { HandyToolsService } from './handy-tools.service';
import { LlmService } from './llm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HandyMessage, User]),
    BookingModule,
    CatalogModule,
  ],
  controllers: [HandyController],
  providers: [LlmService, HandyToolsService, HandyChatService],
})
export class HandyModule {}
