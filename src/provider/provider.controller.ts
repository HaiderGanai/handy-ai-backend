import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { OnboardProviderDto } from './dto/onboard-provider.dto';
import { UpdateProviderProfileDto } from './dto/update-provider-profile.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
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
    FileInterceptor('document', {
      limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
    }),
  )
  async uploadDocument(
    @Req() req: AuthenticatedRequest,
    @Body() body: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.providerService.uploadDocument(req.user.id, body, file);
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
