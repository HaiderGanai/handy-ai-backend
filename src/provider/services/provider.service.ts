import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ServiceCategory } from '../../catalog/entities/service-category.entity';
import { CloudinaryService } from '../../cloudinary/cloudinary.service';
import { OnboardProviderDto } from '../dto/onboard-provider.dto';
import { UpdateProviderProfileDto } from '../dto/update-provider-profile.dto';
import { UploadDocumentDto } from '../dto/upload-document.dto';
import { AvailabilitySlotDto } from '../dto/availability-slot.dto';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { ProviderStatus } from '../enums/provider-status.enum';

const ALLOWED_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
];

@Injectable()
export class ProviderService {
  constructor(
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(ProviderDocument)
    private readonly documentRepository: Repository<ProviderDocument>,
    @InjectRepository(ServiceCategory)
    private readonly categoryRepository: Repository<ServiceCategory>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async onboardProvider(
    userId: string,
    data: OnboardProviderDto,
  ): Promise<Provider> {
    //one provider profile per user
    const existing = await this.providerRepository.findOne({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException('Provider profile already exists!');
    }

    const categories = await this.findCategories(data.categoryIds);
    this.assertValidAvailability(data.availability);

    const provider = this.providerRepository.create({
      userId,
      bio: data.bio,
      postcodeCoverage: data.postcodeCoverage,
      categories,
      availability: data.availability,
    });
    return this.providerRepository.save(provider);
  }

  async getProfile(userId: string): Promise<Provider> {
    const provider = await this.providerRepository.findOne({
      where: { userId },
      relations: { categories: true, availability: true, documents: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    return provider;
  }

  async updateProfile(
    userId: string,
    data: UpdateProviderProfileDto,
  ): Promise<Provider> {
    const provider = await this.getProfile(userId);

    //copy only the fields that were sent (omitted DTO fields are own `undefined` props)
    if (data.bio !== undefined) {
      provider.bio = data.bio;
    }
    if (data.postcodeCoverage !== undefined) {
      provider.postcodeCoverage = data.postcodeCoverage;
    }
    if (data.categoryIds !== undefined) {
      provider.categories = await this.findCategories(data.categoryIds);
    }
    if (data.availability !== undefined) {
      this.assertValidAvailability(data.availability);
      provider.availability = data.availability as Provider['availability'];
    }
    return this.providerRepository.save(provider);
  }

  async uploadDocument(
    userId: string,
    data: UploadDocumentDto,
    file: Express.Multer.File | undefined,
  ): Promise<ProviderDocument> {
    if (!file) {
      throw new BadRequestException('Document file is required!');
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG or PDF files are allowed!');
    }

    const provider = await this.providerRepository.findOne({
      where: { userId },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }

    //upload to cloudinary and store the returned secure url
    const result = await this.cloudinaryService.uploadBuffer(
      file.buffer,
      `handy-ai/provider-documents/${provider.id}`,
    );

    //re-uploading a type replaces it and sends it back for review
    const document =
      (await this.documentRepository.findOne({
        where: { provider: { id: provider.id }, type: data.type },
      })) ?? this.documentRepository.create({ provider, type: data.type });
    document.fileUrl = result.secure_url;
    document.status = DocumentStatus.PENDING;
    const saved = await this.documentRepository.save(document);

    //a rejected provider who resubmits goes back into the review queue
    if (provider.status === ProviderStatus.REJECTED) {
      provider.status = ProviderStatus.PENDING;
      provider.rejectionReason = null;
      await this.providerRepository.save(provider);
    }
    return saved;
  }

  private async findCategories(ids: string[]): Promise<ServiceCategory[]> {
    const uniqueIds = [...new Set(ids)];
    const categories = await this.categoryRepository.find({
      where: { id: In(uniqueIds) },
    });
    if (categories.length !== uniqueIds.length) {
      throw new BadRequestException(
        'One or more service categories are invalid!',
      );
    }
    return categories;
  }

  private assertValidAvailability(slots: AvailabilitySlotDto[]): void {
    //HH:mm strings compare correctly as text
    if (slots.some((slot) => slot.startTime >= slot.endTime)) {
      throw new BadRequestException(
        'Availability start time must be before end time!',
      );
    }
  }
}
