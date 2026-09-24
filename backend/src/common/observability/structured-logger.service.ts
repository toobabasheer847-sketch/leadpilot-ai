import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestContextService } from './request-context.service';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = /password|secret|token|authorization|cookie|api[-_]?key|credential|database[-_]?url|redis[-_]?url/i;

@Injectable()
export class StructuredLoggerService {
  private readonly logger = new Logger('Application');

  constructor(
    private readonly context: RequestContextService,
    private readonly config: ConfigService,
  ) {}

  info(operation: string, metadata: Record<string, unknown> = {}) {
    this.write('INFO', operation, metadata);
  }

  warn(operation: string, metadata: Record<string, unknown> = {}) {
    this.write('WARN', operation, metadata);
  }

  error(operation: string, metadata: Record<string, unknown> = {}) {
    this.write('ERROR', operation, metadata);
  }

  private write(level: string, operation: string, metadata: Record<string, unknown>) {
    const requestContext = this.context.get();
    const payload = this.redact({
      timestamp: new Date().toISOString(),
      level,
      service: 'leadpilot-api',
      environment: this.config.get<string>('nodeEnv', 'development'),
      operation,
      ...requestContext,
      ...metadata,
    });
    const line = JSON.stringify(payload);
    if (level === 'ERROR') this.logger.error(line);
    else if (level === 'WARN') this.logger.warn(line);
    else this.logger.log(line);
  }

  private redact(value: unknown, key?: string): unknown {
    if (key && SENSITIVE_KEYS.test(key)) return REDACTED;
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, this.redact(entryValue, entryKey)]));
    }
    return value;
  }
}