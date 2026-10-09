import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentType } from '../enums/document-type.enum';
import { ProviderStatus } from '../enums/provider-status.enum';
import { AdminProviderService } from './admin-provider.service';

describe('AdminProviderService', () => {
  let service: AdminProviderService;
  const providerRepo = {
    findOne: jest.fn(),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const documentRepo = { save: jest.fn() };

  const allDocuments = () =>
    Object.values(DocumentType).map((type) => ({
      type,
      status: DocumentStatus.PENDING,
    }));

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AdminProviderService,
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        {
          provide: getRepositoryToken(ProviderDocument),
          useValue: documentRepo,
        },
      ],
    }).compile();
    service = module.get(AdminProviderService);
  });

  it('refuses to approve a provider with missing documents', async () => {
    providerRepo.findOne.mockResolvedValue({
      status: ProviderStatus.PENDING,
      documents: allDocuments().slice(1),
    });
    await expect(service.approveProvider('p1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('approves a complete pending provider and approves its documents', async () => {
    const documents = allDocuments();
    providerRepo.findOne.mockResolvedValue({
      status: ProviderStatus.PENDING,
      documents,
    });

    const result = await service.approveProvider('p1');

    expect(result.status).toBe(ProviderStatus.APPROVED);
    expect(documents.every((d) => d.status === DocumentStatus.APPROVED)).toBe(
      true,
    );
  });

  it('only rejects pending providers and stores the reason', async () => {
    providerRepo.findOne.mockResolvedValueOnce({
      status: ProviderStatus.APPROVED,
      documents: [],
    });
    await expect(service.rejectProvider('p1', {})).rejects.toThrow(
      BadRequestException,
    );

    providerRepo.findOne.mockResolvedValueOnce({
      status: ProviderStatus.PENDING,
      documents: [],
    });
    const result = await service.rejectProvider('p1', { reason: 'Bad ID' });
    expect(result.rejectionReason).toBe('Bad ID');
  });

  it('only disables approved providers', async () => {
    providerRepo.findOne.mockResolvedValue({
      status: ProviderStatus.PENDING,
      documents: [],
    });
    await expect(service.disableProvider('p1')).rejects.toThrow(
      BadRequestException,
    );
  });
});
