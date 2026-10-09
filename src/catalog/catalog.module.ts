import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ServiceCategory } from './entities/service-category.entity';
import { SubService } from './entities/sub-service.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceCategory, SubService])],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [TypeOrmModule, CatalogService],
})
export class CatalogModule {}
