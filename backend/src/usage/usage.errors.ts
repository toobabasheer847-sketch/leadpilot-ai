import { HttpException, HttpStatus } from '@nestjs/common';

export class UsageLimitExceededException extends HttpException {
  constructor(limit: string, remaining: number, resetAt: Date) {
    super({ statusCode: 429, code: 'USAGE_LIMIT_EXCEEDED', message: 'Usage limit exceeded', limit, remaining, resetAt: resetAt.toISOString() }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
