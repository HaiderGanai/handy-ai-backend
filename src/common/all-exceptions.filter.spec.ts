import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  const json = jest.fn<void, [{ message: string | string[] }]>();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/x' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;

  beforeEach(() => jest.clearAllMocks());

  it('keeps status and message of an HttpException', () => {
    filter.catch(new ConflictException('Provider is not available!'), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        error: 'Conflict',
        message: 'Provider is not available!',
        path: '/api/v1/x',
      }),
    );
  });

  it('passes validation message arrays through', () => {
    filter.catch(
      new BadRequestException({
        message: ['email must be an email'],
        error: 'Bad Request',
      }),
      host,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['email must be an email'] }),
    );
  });

  it('hides the cause of an unknown error behind a generic 500', () => {
    filter.catch(new Error('connection to db refused at 10.0.0.5'), host);
    expect(status).toHaveBeenCalledWith(500);
    const [body] = json.mock.calls[0];
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});
