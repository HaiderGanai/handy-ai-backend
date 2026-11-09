import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  content: string | null;
  toolCalls: LlmToolCall[];
}

// The only file that talks to the OpenAI SDK. Everything else mocks this class in tests.
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private openai?: OpenAI;

  constructor(private readonly config: ConfigService) {}

  async complete(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
  ): Promise<LlmResult> {
    const client = this.client();
    const model = this.config.get<string>('OPENAI_MODEL');
    if (!model) {
      throw new ServiceUnavailableException('Handy is not configured!');
    }
    try {
      const response = await client.chat.completions.create({
        model,
        // function tools on Chat Completions are rejected by the GPT-6 models unless reasoning is off
        reasoning_effort: 'none',
        messages: messages.map((m) => this.toSdkMessage(m)),
        ...(tools.length > 0 && {
          tools: tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      });
      const message = response.choices[0].message;
      return {
        content: message.content ?? null,
        toolCalls: (message.tool_calls ?? []).flatMap((call) =>
          call.type === 'function'
            ? [
                {
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              ]
            : [],
        ),
      };
    } catch (error) {
      this.logger.error('LLM call failed', error);
      throw new BadGatewayException('Handy is unavailable, please retry!');
    }
  }

  private toSdkMessage(
    m: LlmMessage,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  }

  private client(): OpenAI {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('Handy is not configured!');
    }
    this.openai ??= new OpenAI({ apiKey });
    return this.openai;
  }
}
