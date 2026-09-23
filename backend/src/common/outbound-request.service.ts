import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class OutboundRequestError extends Error {
  constructor(message = 'Outbound request failed') {
    super(message);
    this.name = OutboundRequestError.name;
  }
}

@Injectable()
export class OutboundRequestService {
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(configService: ConfigService) {
    this.timeoutMs = configService.get<number>('outbound.timeoutMs', 10000);
    this.retries = configService.get<number>('outbound.retries', 2);
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        return await globalThis.fetch(input, { ...init, signal: controller.signal });
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new OutboundRequestError(lastError instanceof Error && lastError.name === 'AbortError'
      ? 'Outbound request timed out'
      : undefined);
  }
}
