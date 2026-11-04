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
import { ChatDto } from './dto/chat.dto';
import { ListChatQueryDto } from './dto/list-chat-query.dto';
import { HandyChatService } from './handy-chat.service';

@Controller('handy')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.CUSTOMER)
export class HandyController {
  constructor(private readonly handyChatService: HandyChatService) {}

  @Post('/chat')
  async chat(@Req() req: AuthenticatedRequest, @Body() body: ChatDto) {
    return this.handyChatService.chat(req.user.id, body);
  }

  @Get('/chat')
  async getChat(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListChatQueryDto,
  ) {
    return this.handyChatService.getChat(req.user.id, query);
  }

  @Post('/plans/:planId/confirm')
  async confirmPlan(
    @Req() req: AuthenticatedRequest,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.handyChatService.confirmPlan(req.user.id, planId);
  }
}
