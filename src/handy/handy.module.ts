import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HandyMessage } from './entities/handy-message.entity';
import { LlmService } from './llm.service';

@Module({
  imports: [TypeOrmModule.forFeature([HandyMessage])],
  providers: [LlmService],
})
export class HandyModule {}
