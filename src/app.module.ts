import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppCacheModule } from './cache/app-cache.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AppCacheModule,
    MailModule,
    CloudinaryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
