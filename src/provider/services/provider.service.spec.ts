import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ServiceCategory } from '../../catalog/entities/service-category.entity';
import { CloudinaryService } from '../../cloudinary/cloudinary.service';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentStatus } from '../enums/document-status.enum';
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

  it('rejects an upload with no files', async () => {
    await expect(service.uploadDocuments('u1', {})).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-multipart upload (files undefined) with 400, not a crash', async () => {
    // multer leaves req.files undefined when the request is not multipart/form-data
    await expect(
      service.uploadDocuments('u1', undefined as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects disallowed document file types', async () => {
    const file = { mimetype: 'text/html' } as Express.Multer.File;
    await expect(
      service.uploadDocuments('u1', { [DocumentType.GOVERNMENT_ID]: [file] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('uploads several documents, replacing existing ones and resetting a rejected provider', async () => {
    const existing = {
      type: DocumentType.REFERENCE,
      fileUrl: 'old',
      status: DocumentStatus.REJECTED,
    };
    const provider = {
      id: 'p1',
      status: ProviderStatus.REJECTED,
      documents: [existing],
    };
    providerRepo.findOne.mockResolvedValue(provider);
    uploadBuffer.mockResolvedValue({ secure_url: 'https://x/new' });
    const file = {
      mimetype: 'application/pdf',
      buffer: Buffer.from(''),
    } as Express.Multer.File;

    const saved = await service.uploadDocuments('u1', {
      [DocumentType.REFERENCE]: [file],
      [DocumentType.GOVERNMENT_ID]: [file],
    });

    expect(saved).toHaveLength(2);
    expect(uploadBuffer).toHaveBeenCalledTimes(2);
    expect(existing).toMatchObject({
      fileUrl: 'https://x/new',
      status: DocumentStatus.PENDING,
    });
    expect(provider.status).toBe(ProviderStatus.PENDING);
  });

  describe('profile', () => {
    const makeProfile = () => ({
      id: 'p1',
      userId: 'u1',
      bio: 'Plumber',
      postcodeCoverage: ['SW1'],
      status: ProviderStatus.APPROVED,
      categories: [{ id: 'c1' }],
      availability: [],
      documents: [],
      user: {
        id: 'u1',
        fullName: 'Alex Pro',
        email: 'alex@example.com',
        photoUrl: 'https://x/photo.jpg',
        address: '1 High St',
        postcode: 'SW1',
        householdNotes: 'customer-only secret',
        role: 'PROVIDER',
      },
    });

    it('keeps the existing provider fields and adds a projected user object', async () => {
      providerRepo.findOne.mockResolvedValue(makeProfile());
      const profile = await service.getProfile('u1');
      expect(profile).toMatchObject({
        id: 'p1',
        userId: 'u1',
        bio: 'Plumber',
        status: ProviderStatus.APPROVED,
        categories: [{ id: 'c1' }],
      });
      expect(profile.user).toEqual({
        fullName: 'Alex Pro',
        email: 'alex@example.com',
        photoUrl: 'https://x/photo.jpg',
        address: '1 High St',
        postcode: 'SW1',
      });
    });

    it('404s when the caller has no provider profile', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      await expect(service.getProfile('u1')).rejects.toThrow(NotFoundException);
    });

    it('PATCH changes only the sent fields and returns the same full shape as GET', async () => {
      // behave like a database: save stores the row, later reads return it
      let row = makeProfile();
      providerRepo.findOne.mockImplementation(() => Promise.resolve(row));
      providerRepo.save.mockImplementation((value: typeof row) => {
        row = { ...value };
        return Promise.resolve(value);
      });
      const updated = await service.updateProfile('u1', { bio: 'Electrician' });
      expect(updated.bio).toBe('Electrician');
      expect(updated.postcodeCoverage).toEqual(['SW1']);
      expect(updated.user).toEqual({
        fullName: 'Alex Pro',
        email: 'alex@example.com',
        photoUrl: 'https://x/photo.jpg',
        address: '1 High St',
        postcode: 'SW1',
      });
    });
  });
});
