import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  // ponytail: log-only until Phase 7 wires FCM; callers keep this signature
  notify(
    userId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.logger.log(`notify ${userId} ${event} ${JSON.stringify(payload)}`);
  }
}
