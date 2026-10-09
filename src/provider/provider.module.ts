import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceCategory } from '../catalog/entities/service-category.entity';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { AdminProviderController } from './admin-provider.controller';
import { ProviderAvailability } from './entities/provider-availability.entity';
import { ProviderDocument } from './entities/provider-document.entity';
import { Provider } from './entities/provider.entity';
import { ProviderController } from './provider.controller';
import { AdminProviderService } from './services/admin-provider.service';
import { ProviderService } from './services/provider.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Provider,
      ProviderAvailability,
      ProviderDocument,
      ServiceCategory,
    ]),
    CloudinaryModule,
  ],
  controllers: [ProviderController, AdminProviderController],
  providers: [ProviderService, AdminProviderService],
  exports: [TypeOrmModule, ProviderService],
})
export class ProviderModule {}
