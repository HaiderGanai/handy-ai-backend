import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { DocumentType } from './enums/document-type.enum';
import { OnboardProviderDto } from './dto/onboard-provider.dto';
import { UpdateProviderProfileDto } from './dto/update-provider-profile.dto';
import { ProviderService } from './services/provider.service';

const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;

@Controller('provider')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.PROVIDER)
export class ProviderController {
  constructor(private readonly providerService: ProviderService) {}

  @Post('/onboarding')
  async onboardProvider(
    @Req() req: AuthenticatedRequest,
    @Body() body: OnboardProviderDto,
  ) {
    return this.providerService.onboardProvider(req.user.id, body);
  }

  @Post('/documents')
  @UseInterceptors(
    FileFieldsInterceptor(
      Object.values(DocumentType).map((name) => ({ name, maxCount: 1 })),
      { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } },
    ),
  )
  async uploadDocuments(
    @Req() req: AuthenticatedRequest,
    @UploadedFiles()
    files: Partial<Record<DocumentType, Express.Multer.File[]>>,
  ) {
    return this.providerService.uploadDocuments(req.user.id, files);
  }

  @Get('/profile')
  async getProfile(@Req() req: AuthenticatedRequest) {
    return this.providerService.getProfile(req.user.id);
  }

  @Patch('/profile')
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateProviderProfileDto,
  ) {
    return this.providerService.updateProfile(req.user.id, body);
  }
}
