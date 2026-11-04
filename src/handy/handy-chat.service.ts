import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheKeys } from '../common/cache-keys';
import { RedisService } from '../redis/redis.service';
import { User } from '../user/entities/user.entity';
import { ChatDto } from './dto/chat.dto';
import { ListChatQueryDto } from './dto/list-chat-query.dto';
import {
  HandyMessage,
  HandyMessageRole,
} from './entities/handy-message.entity';
import { buildSystemPrompt } from './handy.prompt';
import { HandyToolsService, PlanCard } from './handy-tools.service';
import { LlmMessage, LlmService } from './llm.service';

const HISTORY_FOR_MODEL = 20;
const MAX_MODEL_ROUNDS = 5;
const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_SECONDS = 3600;
const GAVE_UP_REPLY = "I'm sorry, I couldn't finish that - could you rephrase?";

@Injectable()
export class HandyChatService {
  constructor(
    @InjectRepository(HandyMessage)
    private readonly handyMessageRepository: Repository<HandyMessage>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly llmService: LlmService,
    private readonly handyToolsService: HandyToolsService,
    private readonly redisService: RedisService,
    private readonly config: ConfigService,
  ) {}

  async chat(
    userId: string,
    data: ChatDto,
  ): Promise<{ reply: string; plan?: PlanCard }> {
    //usage threshold per window
    await this.assertWithinUsageLimit(userId);

    //context: who is asking and what was said before
    const user = await this.userRepository.findOne({ where: { id: userId } });
    const previous = await this.handyMessageRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: HISTORY_FOR_MODEL,
    });
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          now: new Date(),
          timezone: data.timezone ?? 'UTC',
          fullName: user?.fullName ?? null,
          postcode: user?.postcode ?? null,
        }),
      },
      ...previous.reverse().map((m) => ({
        role:
          m.role === HandyMessageRole.USER
            ? ('user' as const)
            : ('assistant' as const),
        content: m.content,
      })),
      { role: 'user', content: data.message },
    ];

    //bounded tool loop: the model asks, the server runs the tool as this user
    let reply = GAVE_UP_REPLY;
    let plan: PlanCard | undefined;
    for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
      const response = await this.llmService.complete(
        messages,
        this.handyToolsService.definitions,
      );
      if (response.toolCalls.length === 0) {
        reply = response.content?.trim() || GAVE_UP_REPLY;
        break;
      }
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      });
      for (const call of response.toolCalls) {
        const outcome = await this.handyToolsService.execute(
          userId,
          call.name,
          call.arguments,
        );
        plan = outcome.plan ?? plan;
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(outcome.result),
        });
      }
    }

    //store the turn only now that it produced a reply; explicit times keep the order stable
    const askedAt = new Date();
    await this.handyMessageRepository.save([
      this.handyMessageRepository.create({
        userId,
        role: HandyMessageRole.USER,
        content: data.message,
        createdAt: askedAt,
      }),
      this.handyMessageRepository.create({
        userId,
        role: HandyMessageRole.ASSISTANT,
        content: reply,
        createdAt: new Date(askedAt.getTime() + 1),
      }),
    ]);
    return { reply, plan };
  }

  async getChat(userId: string, query: ListChatQueryDto) {
    const latest = await this.handyMessageRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 50,
    });
    return {
      messages: latest.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  }

  private async assertWithinUsageLimit(userId: string): Promise<void> {
    const limit = Number(this.config.get('HANDY_CHAT_LIMIT') ?? DEFAULT_LIMIT);
    const windowSeconds = Number(
      this.config.get('HANDY_CHAT_WINDOW_SECONDS') ?? DEFAULT_WINDOW_SECONDS,
    );
    const used = await this.redisService.incrementWithExpiry(
      CacheKeys.handyChatRate(userId),
      windowSeconds,
    );
    if (used > limit) {
      throw new HttpException(
        'You are chatting too fast, please try again shortly!',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
