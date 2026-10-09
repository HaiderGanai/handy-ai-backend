import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceCategory } from './entities/service-category.entity';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(ServiceCategory)
    private readonly serviceCategoryRepository: Repository<ServiceCategory>,
  ) {}

  async getServiceCategories(): Promise<ServiceCategory[]> {
    //categories with their sub-services, both in the seeded display order
    return this.serviceCategoryRepository.find({
      relations: { subServices: true },
      order: { sortOrder: 'ASC', subServices: { sortOrder: 'ASC' } },
    });
  }
}
