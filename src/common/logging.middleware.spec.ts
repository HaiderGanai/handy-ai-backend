import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { LoggingMiddleware } from './logging.middleware';

describe('LoggingMiddleware', () => {
  const middleware = new LoggingMiddleware();
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

  const run = (statusCode: number, originalUrl = '/api/v1/x') => {
    const res = Object.assign(new EventEmitter(), { statusCode });
    const next = jest.fn();
    middleware.use({ method: 'GET', originalUrl } as never, res as never, next);
    res.emit('finish');
    expect(next).toHaveBeenCalled();
  };

  beforeEach(() => jest.clearAllMocks());

  it('logs by status class', () => {
    run(200);
    run(404);
    run(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('drops the query string so tokens never reach the log', () => {
    run(200, '/api/v1/x?token=secret');
    expect(log.mock.calls[0][0]).toMatch(/^GET \/api\/v1\/x 200 \d+ms$/);
  });
});
