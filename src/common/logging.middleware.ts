import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

// one line per request once the response is sent; never logs bodies (passwords, OTPs, tokens)
@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      const line = `${req.method} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`;
      if (res.statusCode >= 500) {
        this.logger.error(line);
      } else if (res.statusCode >= 400) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    });
    next();
  }
}
