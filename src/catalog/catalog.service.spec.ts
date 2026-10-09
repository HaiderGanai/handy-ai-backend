import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CatalogService } from './catalog.service';
import { ServiceCategory } from './entities/service-category.entity';

describe('CatalogService', () => {
  let service: CatalogService;
  const find = jest.fn();

  beforeEach(async () => {
    find.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: getRepositoryToken(ServiceCategory), useValue: { find } },
      ],
    }).compile();
    service = module.get(CatalogService);
  });

  it('returns categories with sub-services in display order', async () => {
    const categories = [{ slug: 'cleaning', subServices: [] }];
    find.mockResolvedValue(categories);

    await expect(service.getServiceCategories()).resolves.toBe(categories);
    expect(find).toHaveBeenCalledWith({
      relations: { subServices: true },
      order: { sortOrder: 'ASC', subServices: { sortOrder: 'ASC' } },
    });
  });
});
