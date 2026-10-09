import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppCacheModule } from './cache/app-cache.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { RedisModule } from './redis/redis.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AppCacheModule,
    RedisModule,
    MailModule,
    CloudinaryModule,
    UserModule,
    AuthModule,
    CatalogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
