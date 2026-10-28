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
import { AvailabilitySlotDto } from '../dto/availability-slot.dto';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentType } from '../enums/document-type.enum';
import { ProviderStatus } from '../enums/provider-status.enum';

// the provider record as before, plus the account details the profile screen needs
// (projected: the raw user also carries role, householdNotes, OTP/reset fields)
export type ProviderProfile = Omit<Provider, 'user'> & {
  user: {
    fullName: string | null;
    email: string;
    photoUrl: string | null;
    address: string | null;
    postcode: string | null;
  };
};

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

  async getProfile(userId: string): Promise<ProviderProfile> {
    const { user, ...provider } = await this.findProfile(userId);
    return {
      ...provider,
      user: {
        fullName: user.fullName,
        email: user.email,
        photoUrl: user.photoUrl,
        address: user.address,
        postcode: user.postcode,
      },
    };
  }

  async updateProfile(
    userId: string,
    data: UpdateProviderProfileDto,
  ): Promise<ProviderProfile> {
    const provider = await this.findProfile(userId);

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
    // account fields: same per-field undefined check; saved with the provider (cascade update)
    if (data.user?.fullName !== undefined) {
      provider.user.fullName = data.user.fullName;
    }
    if (data.user?.address !== undefined) {
      provider.user.address = data.user.address;
    }
    if (data.user?.postcode !== undefined) {
      provider.user.postcode = data.user.postcode;
    }
    await this.providerRepository.save(provider);
    // re-read so PATCH returns exactly what GET returns
    return this.getProfile(userId);
  }

  async uploadDocuments(
    userId: string,
    files: Partial<Record<DocumentType, Express.Multer.File[]>>,
  ): Promise<ProviderDocument[]> {
    //the field name of each file is its document type; `files` is undefined when the request isn't multipart
    const uploads = Object.entries(files ?? {}).map(([type, [file]]) => ({
      type: type as DocumentType,
      file,
    }));
    if (uploads.length === 0) {
      throw new BadRequestException('At least one document file is required!');
    }
    if (
      uploads.some(
        ({ file }) => !ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype),
      )
    ) {
      throw new BadRequestException('Only JPEG, PNG or PDF files are allowed!');
    }

    const provider = await this.providerRepository.findOne({
      where: { userId },
      relations: { documents: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }

    //upload to cloudinary and store the returned secure urls
    const urls = await Promise.all(
      uploads.map(({ file }) =>
        this.cloudinaryService.uploadBuffer(
          file.buffer,
          `handy-ai/provider-documents/${provider.id}`,
        ),
      ),
    );

    //re-uploading a type replaces it and sends it back for review
    const documents = uploads.map(({ type }, index) => {
      const document =
        provider.documents.find((existing) => existing.type === type) ??
        this.documentRepository.create({ provider, type });
      document.fileUrl = urls[index].secure_url;
      document.status = DocumentStatus.PENDING;
      return document;
    });
    const saved = await this.documentRepository.save(documents);

    //a rejected provider who resubmits goes back into the review queue
    if (provider.status === ProviderStatus.REJECTED) {
      provider.status = ProviderStatus.PENDING;
      provider.rejectionReason = null;
      await this.providerRepository.save(provider);
    }
    return saved;
  }

  private async findProfile(userId: string): Promise<Provider> {
    const provider = await this.providerRepository.findOne({
      where: { userId },
      relations: {
        user: true,
        categories: true,
        availability: true,
        documents: true,
      },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    return provider;
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
