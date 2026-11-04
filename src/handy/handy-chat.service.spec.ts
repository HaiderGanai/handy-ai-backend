import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RedisService } from '../redis/redis.service';
import { ChatDto } from './dto/chat.dto';
import { HandyMessageRole } from './entities/handy-message.entity';
import { HandyChatService } from './handy-chat.service';
import { HandyToolsService, PlanCard } from './handy-tools.service';
import { LlmService } from './llm.service';

describe('HandyChatService', () => {
  const messageRepo = {
    find: jest.fn(),
    save: jest.fn((v: unknown) => Promise.resolve(v)),
    create: jest.fn((v: object) => v),
  };
  const userRepo = { findOne: jest.fn() };
  const llm = { complete: jest.fn() };
  const tools = {
    definitions: [{ name: 'propose_plan', description: '', parameters: {} }],
    execute: jest.fn(),
  };
  const redis = { incrementWithExpiry: jest.fn() };
  const config = {
    get: (key: string) => ({ HANDY_CHAT_LIMIT: '30' })[key],
  } as unknown as ConfigService;

  const service = new HandyChatService(
    messageRepo as never,
    userRepo as never,
    llm as unknown as LlmService,
    tools as unknown as HandyToolsService,
    redis as unknown as RedisService,
    config,
  );

  const card = (planId: string) => ({ planId }) as unknown as PlanCard;

  beforeEach(() => {
    jest.resetAllMocks();
    messageRepo.save.mockImplementation((v: unknown) => Promise.resolve(v));
    messageRepo.create.mockImplementation((v: object) => v);
    messageRepo.find.mockResolvedValue([]);
    userRepo.findOne.mockResolvedValue({ fullName: 'Ava', postcode: 'SW1' });
    redis.incrementWithExpiry.mockResolvedValue(1);
  });

  it('stores the user and assistant messages and returns the reply', async () => {
    llm.complete.mockResolvedValue({ content: 'Hello Ava!', toolCalls: [] });
    const result = await service.chat('u1', { message: 'hi' });
    expect(result).toEqual({ reply: 'Hello Ava!', plan: undefined });
    const saved = messageRepo.save.mock.calls[0][0] as {
      role: HandyMessageRole;
      content: string;
      createdAt: Date;
    }[];
    expect(saved.map((m) => [m.role, m.content])).toEqual([
      [HandyMessageRole.USER, 'hi'],
      [HandyMessageRole.ASSISTANT, 'Hello Ava!'],
    ]);
    expect(saved[1].createdAt.getTime()).toBeGreaterThan(
      saved[0].createdAt.getTime(),
    );
  });

  it('runs requested tools for the caller, feeds results back and returns the plan card', async () => {
    llm.complete
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [{ id: 'c1', name: 'propose_plan', arguments: '{"a":1}' }],
      })
      .mockResolvedValueOnce({
        content: 'Marcus, Tuesday. Confirm?',
        toolCalls: [],
      });
    tools.execute.mockResolvedValue({
      result: { proposed: true },
      plan: card('plan1'),
    });
    const result = await service.chat('u1', { message: 'clean tomorrow' });
    expect(tools.execute).toHaveBeenCalledWith('u1', 'propose_plan', '{"a":1}');
    expect(result.reply).toBe('Marcus, Tuesday. Confirm?');
    expect(result.plan?.planId).toBe('plan1');
    const second = llm.complete.mock.calls[1][0] as {
      role: string;
      toolCallId?: string;
    }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });

  it('returns the last proposed plan when several are proposed', async () => {
    llm.complete
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          { id: 'c1', name: 'propose_plan', arguments: '{}' },
          { id: 'c2', name: 'propose_plan', arguments: '{}' },
        ],
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    tools.execute
      .mockResolvedValueOnce({ result: {}, plan: card('first') })
      .mockResolvedValueOnce({ result: {}, plan: card('second') });
    const result = await service.chat('u1', { message: 'x' });
    expect(result.plan?.planId).toBe('second');
  });

  it('stops after 5 model rounds with the fixed reply', async () => {
    llm.complete.mockResolvedValue({
      content: null,
      toolCalls: [{ id: 'c', name: 'propose_plan', arguments: '{}' }],
    });
    tools.execute.mockResolvedValue({ result: {} });
    const result = await service.chat('u1', { message: 'loop' });
    expect(llm.complete).toHaveBeenCalledTimes(5);
    expect(result.reply).toBe(
      "I'm sorry, I couldn't finish that - could you rephrase?",
    );
  });

  it('429s past the usage limit and never calls the model', async () => {
    redis.incrementWithExpiry.mockResolvedValue(31);
    await expect(service.chat('u1', { message: 'hi' })).rejects.toMatchObject({
      status: 429,
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('counts per user with the configured window', async () => {
    llm.complete.mockResolvedValue({ content: 'ok', toolCalls: [] });
    await service.chat('u1', { message: 'hi' });
    expect(redis.incrementWithExpiry).toHaveBeenCalledWith(
      'handy_chat:u1',
      3600,
    );
  });

  it('stores nothing when the model fails', async () => {
    llm.complete.mockRejectedValue(
      new BadGatewayException('Handy is unavailable, please retry!'),
    );
    await expect(service.chat('u1', { message: 'hi' })).rejects.toThrow(
      BadGatewayException,
    );
    expect(messageRepo.save).not.toHaveBeenCalled();
  });

  it('sends only the last 20 stored messages, oldest first, after the system prompt', async () => {
    messageRepo.find.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        role: HandyMessageRole.USER,
        content: `m${19 - i}`,
      })),
    );
    llm.complete.mockResolvedValue({ content: 'ok', toolCalls: [] });
    await service.chat('u1', { message: 'now' });
    expect(messageRepo.find).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    const sent = llm.complete.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    expect(sent[0].role).toBe('system');
    expect(sent[1].content).toBe('m0');
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'now' });
  });

  it('getChat returns oldest first, 50 by default', async () => {
    messageRepo.find.mockResolvedValue([
      {
        id: '2',
        role: HandyMessageRole.ASSISTANT,
        content: 'b',
        createdAt: new Date(2),
      },
      {
        id: '1',
        role: HandyMessageRole.USER,
        content: 'a',
        createdAt: new Date(1),
      },
    ]);
    const result = await service.getChat('u1', {});
    expect(messageRepo.find).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    expect(result.messages.map((m) => m.id)).toEqual(['1', '2']);
  });
});

describe('ChatDto', () => {
  const check = (data: object) => validate(plainToInstance(ChatDto, data));
  it('trims the message and rejects blank or oversized ones', async () => {
    expect(await check({ message: '   ' })).not.toHaveLength(0);
    expect(await check({ message: 'a'.repeat(1001) })).not.toHaveLength(0);
    const dto = plainToInstance(ChatDto, { message: '  hi ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.message).toBe('hi');
  });
  it('rejects an invalid timezone and accepts a valid one', async () => {
    expect(
      await check({ message: 'hi', timezone: 'Mars/Base' }),
    ).not.toHaveLength(0);
    expect(
      await check({ message: 'hi', timezone: 'Asia/Karachi' }),
    ).toHaveLength(0);
  });
});
