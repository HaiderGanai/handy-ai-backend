import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ServiceCategory } from '../../catalog/entities/service-category.entity';
import { CloudinaryService } from '../../cloudinary/cloudinary.service';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentType } from '../enums/document-type.enum';
import { ProviderStatus } from '../enums/provider-status.enum';
import { ProviderService } from './provider.service';

describe('ProviderService', () => {
  let service: ProviderService;
  const providerRepo = {
    findOne: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const documentRepo = {
    findOne: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const categoryRepo = { find: jest.fn() };
  const uploadBuffer = jest.fn();

  const dto = {
    bio: 'Plumber',
    postcodeCoverage: ['SW1'],
    categoryIds: ['c1'],
    availability: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        ProviderService,
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        {
          provide: getRepositoryToken(ProviderDocument),
          useValue: documentRepo,
        },
        {
          provide: getRepositoryToken(ServiceCategory),
          useValue: categoryRepo,
        },
        { provide: CloudinaryService, useValue: { uploadBuffer } },
      ],
    }).compile();
    service = module.get(ProviderService);
  });

  it('rejects a second onboarding for the same user', async () => {
    providerRepo.findOne.mockResolvedValue({ id: 'p1' });
    await expect(service.onboardProvider('u1', dto)).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects unknown category ids', async () => {
    providerRepo.findOne.mockResolvedValue(null);
    categoryRepo.find.mockResolvedValue([]);
    await expect(service.onboardProvider('u1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects availability where start is not before end', async () => {
    providerRepo.findOne.mockResolvedValue(null);
    categoryRepo.find.mockResolvedValue([{ id: 'c1' }]);
    const bad = {
      ...dto,
      availability: [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }],
    };
    await expect(service.onboardProvider('u1', bad)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects disallowed document file types', async () => {
    const file = { mimetype: 'text/html' } as Express.Multer.File;
    await expect(
      service.uploadDocument('u1', { type: DocumentType.GOVERNMENT_ID }, file),
    ).rejects.toThrow(BadRequestException);
  });

  it('resets a rejected provider to pending when a document is re-uploaded', async () => {
    const provider = { id: 'p1', status: ProviderStatus.REJECTED };
    providerRepo.findOne.mockResolvedValue(provider);
    documentRepo.findOne.mockResolvedValue(null);
    uploadBuffer.mockResolvedValue({ secure_url: 'https://x/doc.pdf' });
    const file = {
      mimetype: 'application/pdf',
      buffer: Buffer.from(''),
    } as Express.Multer.File;

    await service.uploadDocument('u1', { type: DocumentType.REFERENCE }, file);

    expect(provider.status).toBe(ProviderStatus.PENDING);
  });
});
