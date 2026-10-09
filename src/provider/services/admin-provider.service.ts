import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListProvidersQueryDto } from '../dto/list-providers-query.dto';
import { RejectProviderDto } from '../dto/reject-provider.dto';
import { ProviderDocument } from '../entities/provider-document.entity';
import { Provider } from '../entities/provider.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentType } from '../enums/document-type.enum';
import { ProviderStatus } from '../enums/provider-status.enum';

@Injectable()
export class AdminProviderService {
  constructor(
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(ProviderDocument)
    private readonly documentRepository: Repository<ProviderDocument>,
  ) {}

  async listProviders(query: ListProvidersQueryDto): Promise<Provider[]> {
    return this.providerRepository.find({
      where: query.status ? { status: query.status } : {},
      relations: {
        user: true,
        categories: true,
        availability: true,
        documents: true,
      },
      order: { createdAt: 'ASC' },
    });
  }

  async approveProvider(id: string): Promise<Provider> {
    const provider = await this.getProvider(id);
    if (
      provider.status !== ProviderStatus.PENDING &&
      provider.status !== ProviderStatus.DISABLED
    ) {
      throw new BadRequestException('Provider cannot be approved!');
    }

    //vetting needs every required document on file
    const uploadedTypes = new Set(provider.documents.map((doc) => doc.type));
    if (Object.values(DocumentType).some((type) => !uploadedTypes.has(type))) {
      throw new BadRequestException('Provider has missing documents!');
    }

    await this.setDocumentStatus(provider, DocumentStatus.APPROVED);
    provider.status = ProviderStatus.APPROVED;
    provider.rejectionReason = null;
    return this.providerRepository.save(provider);
  }

  async rejectProvider(id: string, data: RejectProviderDto): Promise<Provider> {
    const provider = await this.getProvider(id);
    if (provider.status !== ProviderStatus.PENDING) {
      throw new BadRequestException('Only pending providers can be rejected!');
    }

    await this.setDocumentStatus(provider, DocumentStatus.REJECTED);
    provider.status = ProviderStatus.REJECTED;
    provider.rejectionReason = data.reason ?? null;
    return this.providerRepository.save(provider);
  }

  async disableProvider(id: string): Promise<Provider> {
    const provider = await this.getProvider(id);
    if (provider.status !== ProviderStatus.APPROVED) {
      throw new BadRequestException('Only approved providers can be disabled!');
    }

    provider.status = ProviderStatus.DISABLED;
    return this.providerRepository.save(provider);
  }

  async deleteProvider(id: string): Promise<{ message: string }> {
    const provider = await this.getProvider(id);
    await this.providerRepository.remove(provider);
    return { message: 'Provider deleted!' };
  }

  private async getProvider(id: string): Promise<Provider> {
    const provider = await this.providerRepository.findOne({
      where: { id },
      relations: { documents: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider not found!');
    }
    return provider;
  }

  private async setDocumentStatus(
    provider: Provider,
    status: DocumentStatus,
  ): Promise<void> {
    provider.documents.forEach((document) => (document.status = status));
    await this.documentRepository.save(provider.documents);
  }
}
