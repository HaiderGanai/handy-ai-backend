import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../user/enums/role.enum';
import { ListProvidersQueryDto } from './dto/list-providers-query.dto';
import { RejectProviderDto } from './dto/reject-provider.dto';
import { AdminProviderService } from './services/admin-provider.service';

@Controller('admin/providers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class AdminProviderController {
  constructor(private readonly adminProviderService: AdminProviderService) {}

  @Get()
  async listProviders(@Query() query: ListProvidersQueryDto) {
    return this.adminProviderService.listProviders(query);
  }

  @Post('/:id/approve')
  async approveProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminProviderService.approveProvider(id);
  }

  @Post('/:id/reject')
  async rejectProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectProviderDto,
  ) {
    return this.adminProviderService.rejectProvider(id, body);
  }

  @Post('/:id/disable')
  async disableProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminProviderService.disableProvider(id);
  }

  @Delete('/:id')
  async deleteProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminProviderService.deleteProvider(id);
  }
}
