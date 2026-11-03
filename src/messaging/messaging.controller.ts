import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagingService } from './messaging.service';

@Controller('bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post('/:id/messages')
  @Roles(Role.CUSTOMER, Role.PROVIDER)
  async sendMessage(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(
      req.user.id,
      req.user.role,
      id,
      body,
    );
  }

  @Get('/:id/messages')
  @Roles(Role.CUSTOMER, Role.PROVIDER)
  async listMessages(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messagingService.listMessages(
      req.user.id,
      req.user.role,
      id,
      query,
    );
  }
}
