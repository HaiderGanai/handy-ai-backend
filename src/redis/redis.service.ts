import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from '@redis/client';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType;

  constructor(private readonly config: ConfigService) {
    this.client = createClient({ url: this.config.get<string>('REDIS_URL') });
  }

  async onModuleInit() {
    await this.client.connect();
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  // atomic INCR+TTL for rate-limit counters (cache-manager's get/set can't do this atomically)
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}
