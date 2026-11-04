import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';

const create = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create } },
  })),
}));

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const READY = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'some-model' };

describe('LlmService', () => {
  beforeEach(() => create.mockReset());

  it.each([
    ['the API key', { OPENAI_MODEL: 'some-model' }],
    ['the model name', { OPENAI_API_KEY: 'sk-test' }],
  ])('503s when %s is missing', async (_what, values) => {
    const service = new LlmService(config(values));
    await expect(service.complete([], [])).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('maps messages and tools to the SDK request and returns content and tool calls', async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'list_services', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
    const service = new LlmService(config(READY));
    const result = await service.complete(
      [
        { role: 'system', content: 'be Handy' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_0', name: 'x', arguments: '{}' }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_0' },
      ],
      [{ name: 'list_services', description: 'd', parameters: {} }],
    );
    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: 'call_1', name: 'list_services', arguments: '{}' }],
    });
    expect(create).toHaveBeenCalledWith({
      model: 'some-model',
      messages: [
        { role: 'system', content: 'be Handy' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'x', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_0' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'list_services', description: 'd', parameters: {} },
        },
      ],
    });
  });

  it('omits tools when none are given', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: 'hello', tool_calls: undefined } }],
    });
    const service = new LlmService(config(READY));
    await expect(service.complete([], [])).resolves.toEqual({
      content: 'hello',
      toolCalls: [],
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('wraps SDK errors as 502', async () => {
    create.mockRejectedValue(new Error('rate limited'));
    const service = new LlmService(config(READY));
    await expect(service.complete([], [])).rejects.toThrow(BadGatewayException);
  });
});
