import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingModule } from '../booking/booking.module';
import { CatalogModule } from '../catalog/catalog.module';
import { HandyMessage } from './entities/handy-message.entity';
import { HandyToolsService } from './handy-tools.service';
import { LlmService } from './llm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HandyMessage]),
    BookingModule,
    CatalogModule,
  ],
  providers: [LlmService, HandyToolsService],
})
export class HandyModule {}
