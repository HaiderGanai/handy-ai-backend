import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('service-categories')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async getServiceCategories() {
    return this.catalogService.getServiceCategories();
  }
}
