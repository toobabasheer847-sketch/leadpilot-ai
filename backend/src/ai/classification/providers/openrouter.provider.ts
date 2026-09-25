import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildInvestorClassificationPrompt } from '../prompts/investor-classification.prompt';
import { classificationParserCategory, classificationResponseFormat, parseClassificationResult, parseModelJson } from '../schemas/classification.schema';
import { INVESTOR_TYPES, type ClassificationInput, type ClassificationResult } from '../types/classification.types';
import type { LlmProvider } from './llm-provider.interface';

export type OpenRouterErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTHENTICATION'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR';

export type ClassificationFailureCategory =
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'INVALID_ENUM'
  | 'MISSING_REQUIRED_FIELD'
  | 'UNSUPPORTED_RESPONSE_FORMAT';

export class OpenRouterError extends Error {
  readonly parserCategory: ClassificationFailureCategory;

  constructor(
    message: string,
    readonly status: number | null,
    readonly code: OpenRouterErrorCode,
    readonly retryable: boolean,
    readonly responseType = 'none',
    readonly providerCode: string | null = null,
    readonly providerMessage = '',
    readonly responseLength = 0,
    readonly finishReason = 'none',
    parserCategory?: ClassificationFailureCategory,
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.parserCategory = parserCategory ?? categoryForCode(code);
  }
}

interface ChatMessage {
  role: string;
  content: string;
}

@Injectable()
export class OpenRouterProvider implements LlmProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);

  constructor(private readonly config: ConfigService) {}

  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const completion = await this.chat([
      { role: 'system', content: 'Return only valid JSON matching the requested classification schema. Use only the supplied enum values.' },
      { role: 'user', content: buildInvestorClassificationPrompt(input) },
    ], classificationResponseFormat(), { minimalReasoning: true });
    let parsed: unknown;
    try {
      parsed = parseModelJson(completion.content);
      return parseClassificationResult(parsed);
    } catch (error) {
      const settings = this.settings();
      if (error instanceof Error && error.message.startsWith('Invalid investor type')) {
        this.logger.warn(`OpenRouter investorType rejected returned=${returnedInvestorType(parsed)} expected=${INVESTOR_TYPES.join(',')} model=${redactSecrets(settings.model)}`);
      }
      const wrapped = new OpenRouterError(
        error instanceof Error ? error.message : 'OpenRouter returned a malformed classification response',
        completion.status,
        'PARSE_ERROR',
        false,
        completion.contentType,
        null,
        '',
        completion.responseLength,
        completion.finishReason,
        error instanceof OpenRouterError ? error.parserCategory : classificationParserCategory(error),
      );
      this.logFailure(wrapped, settings.model, completion.attempt, settings.timeoutMs);
      throw wrapped;
    }
  }

  async completeJson(system: string, user: string): Promise<unknown> {
    const completion = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    try {
      return parseModelJson(completion.content);
    } catch (error) {
      throw new OpenRouterError(
        error instanceof Error ? error.message : 'OpenRouter returned a malformed classification response',
        completion.status,
        'PARSE_ERROR',
        false,
        completion.contentType,
        null,
        '',
        completion.responseLength,
        completion.finishReason,
        classificationParserCategory(error),
      );
    }
  }

  private async chat(messages: ChatMessage[], responseFormat: Record<string, unknown> = { type: 'json_object' }, options: { minimalReasoning?: boolean } = {}): Promise<ChatCompletion> {
    const settings = this.settings();
    let lastError: OpenRouterError | undefined;
    for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
      try {
        return await this.chatOnce(settings, messages, responseFormat, attempt + 1, options.minimalReasoning === true);
      } catch (error) {
        lastError = toOpenRouterError(error, settings.timeoutMs);
        this.logFailure(lastError, settings.model, attempt + 1, settings.timeoutMs);
        if (!lastError.retryable || attempt >= settings.retries) break;
      }
    }
    throw lastError ?? new OpenRouterError('OpenRouter provider temporarily unavailable', null, 'PROVIDER_ERROR', true);
  }

  private async chatOnce(settings: OpenRouterSettings, messages: ChatMessage[], responseFormat: Record<string, unknown>, attempt: number, minimalReasoning: boolean): Promise<ChatCompletion> {
    let response: Response;
    try {
      response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0,
          response_format: responseFormat,
          ...(minimalReasoning ? { reasoning: { effort: 'minimal' } } : {}),
          messages,
        }),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (error) {
      throw toOpenRouterError(error, settings.timeoutMs);
    }
    const responseType = response.headers?.get('content-type') ?? 'unknown';
    const raw = await response.text();
    if (!response.ok) {
      const detail = providerDetail(raw);
      throw statusError(response.status, responseType, detail, raw.length);
    }
    let payload: { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
    try {
      payload = JSON.parse(raw) as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
    } catch {
      throw new OpenRouterError('OpenRouter returned a malformed classification response', response.status, 'PARSE_ERROR', false, responseType, null, '', raw.length, 'none', 'INVALID_JSON');
    }
    const choice = payload.choices?.[0];
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'none';
    const content = messageContent(choice?.message?.content);
    if (!content.trim()) {
      throw new OpenRouterError('OpenRouter returned an empty classification response', response.status, 'PARSE_ERROR', false, responseType, null, '', raw.length, finishReason, 'EMPTY_RESPONSE');
    }
    return { content, attempt, status: response.status, contentType: responseType, responseLength: raw.length, finishReason };
  }

  private settings(): OpenRouterSettings {
    const apiKey = this.config.get<string>('openRouter.apiKey')?.trim() ?? '';
    const model = this.config.get<string>('openRouter.model')?.trim() ?? '';
    const baseUrl = (this.config.get<string>('openRouter.baseUrl') ?? 'https://openrouter.ai/api/v1').trim().replace(/\/$/, '');
    const timeoutValue = this.config.get<number>('openRouter.timeoutMs');
    const retryValue = this.config.get<number>('openRouter.retries');
    const timeoutMs = Number.isInteger(timeoutValue) ? Number(timeoutValue) : 20000;
    const retries = Number.isInteger(retryValue) ? Math.min(Math.max(Number(retryValue), 0), 5) : 2;
    if (!apiKey || !model || !baseUrl.startsWith('https://')) {
      const error = new OpenRouterError('OpenRouter is not configured', null, 'NOT_CONFIGURED', false);
      this.logFailure(error, model || 'unset', 1, timeoutMs);
      throw error;
    }
    return { apiKey, model, baseUrl, timeoutMs, retries };
  }

  private logFailure(error: OpenRouterError, model: string, attempt: number, timeoutMs: number) {
    this.logger.warn(
      `OpenRouter request failed status=${error.status ?? 'none'} model=${redactSecrets(model)} contentType=${error.responseType} finishReason=${error.finishReason} responseLength=${error.responseLength} parserCategory=${error.parserCategory} validationError=${redactSecrets(error.message)} attempt=${attempt} timeoutMs=${timeoutMs} retryable=${error.retryable} code=${error.code} providerCode=${redactSecrets(error.providerCode ?? 'none')} providerMessage=${redactSecrets(error.providerMessage || 'none')}`,
    );
  }
}

interface ChatCompletion {
  content: string;
  attempt: number;
  status: number;
  contentType: string;
  responseLength: number;
  finishReason: string;
}

interface OpenRouterSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  retries: number;
}

function toOpenRouterError(error: unknown, timeoutMs: number): OpenRouterError {
  if (error instanceof OpenRouterError) return error;
  if (isTimeout(error)) {
    return new OpenRouterError(`OpenRouter request timed out after ${timeoutMs}ms`, null, 'TIMEOUT', true);
  }
  return new OpenRouterError('OpenRouter provider temporarily unavailable', null, 'PROVIDER_ERROR', true);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout|aborted/i.test(error.message));
}

function statusError(status: number, responseType: string, detail: { message: string; code: string | null }, responseLength: number): OpenRouterError {
  if (status === 401 || status === 403) {
    return new OpenRouterError(`OpenRouter authentication failed (status ${status})`, status, 'AUTHENTICATION', false, responseType, detail.code, detail.message, responseLength, 'none', 'AUTH_ERROR');
  }
  if (status === 404) {
    return new OpenRouterError('OpenRouter model is unavailable (status 404)', status, 'MODEL_NOT_FOUND', false, responseType, detail.code, detail.message, responseLength);
  }
  if (status === 429) {
    return new OpenRouterError('OpenRouter rate limit (status 429)', status, 'RATE_LIMITED', true, responseType, detail.code, detail.message, responseLength, 'none', 'RATE_LIMIT');
  }
  if (status === 408) {
    return new OpenRouterError('OpenRouter request timed out (status 408)', status, 'TIMEOUT', true, responseType, detail.code, detail.message, responseLength, 'none', 'TIMEOUT');
  }
  if (status >= 500) {
    return new OpenRouterError(`OpenRouter provider temporarily unavailable (status ${status})`, status, 'PROVIDER_ERROR', true, responseType, detail.code, detail.message, responseLength, 'none', 'PROVIDER_ERROR');
  }
  const unsupportedFormat = /response_format|json_schema|structured output/i.test(detail.message);
  return new OpenRouterError(`OpenRouter rejected the classification request (status ${status})`, status, 'INVALID_REQUEST', false, responseType, detail.code, detail.message, responseLength, 'none', unsupportedFormat ? 'UNSUPPORTED_RESPONSE_FORMAT' : 'INVALID_SCHEMA');
}

function categoryForCode(code: OpenRouterErrorCode): ClassificationFailureCategory {
  if (code === 'AUTHENTICATION') return 'AUTH_ERROR';
  if (code === 'RATE_LIMITED') return 'RATE_LIMIT';
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'PROVIDER_ERROR') return 'PROVIDER_ERROR';
  if (code === 'PARSE_ERROR') return 'INVALID_JSON';
  if (code === 'INVALID_REQUEST') return 'INVALID_SCHEMA';
  return 'PROVIDER_ERROR';
}

function providerDetail(raw: string): { message: string; code: string | null } {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } };
    return {
      message: typeof body.error?.message === 'string' ? body.error.message : '',
      code: typeof body.error?.code === 'string' || typeof body.error?.code === 'number' ? String(body.error.code) : null,
    };
  } catch {
    return { message: '', code: null };
  }
}

function messageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return JSON.stringify(value);
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
    return '';
  }).join('');
}

function returnedInvestorType(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || !('investorType' in parsed)) return 'missing';
  const value = (parsed as { investorType?: unknown }).investorType;
  if (value === null) return 'null';
  if (typeof value !== 'string') return typeof value;
  return redactSecrets(value).slice(0, 80);
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/api[_-]?key["']?\s*[:=]\s*\S+/gi, 'api_key=[redacted]')
    .slice(0, 300);
}
