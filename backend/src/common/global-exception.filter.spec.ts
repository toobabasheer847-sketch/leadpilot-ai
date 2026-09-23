import { ArgumentsHost, HttpException } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  it('returns a consistent safe response for an internal error', () => {
    const json = jest.fn();
    const response = {
      locals: { requestId: 'request-123' },
      status: jest.fn().mockReturnThis(),
      json,
    };
    const request = { originalUrl: '/api/v1/health', header: jest.fn() };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new GlobalExceptionFilter().catch(new Error('database password=secret'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'request-123',
      path: '/api/v1/health',
    }));
  });

  it('preserves safe client errors', () => {
    const json = jest.fn();
    const response = {
      locals: { requestId: 'request-456' },
      status: jest.fn().mockReturnThis(),
      json,
    };
    const request = { originalUrl: '/api/v1/test', header: jest.fn() };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new GlobalExceptionFilter().catch(new HttpException('Bad request', 400), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      message: 'Bad request',
    }));
  });
});
