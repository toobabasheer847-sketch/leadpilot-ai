import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClassificationInput } from '../types/classification.types';
import { OpenRouterError, OpenRouterProvider } from './openrouter.provider';

const input: ClassificationInput = {
  company: {
    id: 'company-1',
    name: 'Stored company',
    description: null,
    website: null,
    category: null,
    investorType: null,
    investmentStrategy: null,
    employeeCount: null,
    employeeRange: null,
  },
  criteria: { category: 'REAL_ESTATE_INVESTOR' },
  evidence: [],
};

const classification = {
  decision: 'QUALIFIED',
  confidence: 0.9,
  category: 'REAL_ESTATE_INVESTOR',
  investorType: 'CASH_HOME_BUYER',
  reasons: ['Cited supplied evidence'],
  positiveEvidence: ['evidence-1'],
  negativeEvidence: [],
  missingEvidence: [],
  exclusionReason: null,
  companySizeVerification: 'NOT_FOUND',
  locationStatus: 'NOT_FOUND',
};

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as ConfigService;
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as Response;
}

function completion(content: unknown) {
  return { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
}

describe('OpenRouterProvider', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  let warn: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warn.mockRestore();
  });

  function provider(overrides: Record<string, unknown> = {}) {
    return new OpenRouterProvider(config({
      'openRouter.apiKey': 'test-key',
      'openRouter.model': 'configured/model',
      'openRouter.baseUrl': 'https://openrouter.ai/api/v1',
      'openRouter.timeoutMs': 20000,
      'openRouter.retries': 2,
      ...overrides,
    }));
  }

  function warnings() {
    return warn.mock.calls.map((call) => String(call[0])).join('\n');
  }

  function assertSafeLogs() {
    const logged = warnings();
    expect(logged).not.toContain('test-key');
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('Stored company');
    expect(logged).not.toContain('sk-or-secret');
  }

  it('classifies with the configured model and accepts evidence id strings', async () => {
    fetchMock.mockResolvedValueOnce(response(200, completion(classification)));
    const result = await provider().classify(input);
    expect(result.decision).toBe('QUALIFIED');
    expect(result.positiveEvidence).toEqual([{ evidenceId: 'evidence-1', reason: '' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as { model: string; temperature: number; reasoning: { effort: string }; response_format: { type: string; json_schema: { schema: { properties: { investorType: { enum: string[] } } } } } };
    expect(body.model).toBe('configured/model');
    expect(body.temperature).toBe(0);
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.properties.investorType.enum).toContain('CASH_HOME_BUYER');
    expect(body.response_format.json_schema.schema.properties.investorType.enum).toContain('NOT_DETERMINED');
    expect(warnings()).toBe('');
  });

  it('does not call OpenRouter when configuration is missing', async () => {
    await expect(provider({ 'openRouter.model': undefined }).classify(input)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toContain('code=NOT_CONFIGURED');
    assertSafeLogs();
  });

  it.each([401, 403])('reports authentication failure %s without retrying', async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: { message: 'bad key sk-or-secret', code: 'invalid_api_key' } }));
    await expect(provider().classify(input)).rejects.toMatchObject({ status, code: 'AUTHENTICATION', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain(`status=${status}`);
    expect(warnings()).toContain('providerCode=invalid_api_key');
    expect(warnings()).toContain('model=configured/model');
    expect(warnings()).toContain('attempt=1');
    assertSafeLogs();
  });

  it('reports an unavailable model without retrying', async () => {
    fetchMock.mockResolvedValue(response(404, { error: { message: 'model not found', code: 'model_not_found' } }));
    const error = await provider().classify(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error).toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('status=404');
    expect(warnings()).toContain('providerCode=model_not_found');
    assertSafeLogs();
  });

  it('retries a rate limit and then accepts the classification', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { error: { message: 'slow down', code: 'rate_limit' } }))
      .mockResolvedValueOnce(response(200, completion(classification)));
    await expect(provider({ 'openRouter.retries': 2 }).classify(input)).resolves.toMatchObject({ decision: 'QUALIFIED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toContain('code=RATE_LIMITED');
    expect(warnings()).toContain('retryable=true');
    assertSafeLogs();
  });

  it('retries provider 5xx failures and stops after the retry budget', async () => {
    fetchMock.mockResolvedValue(response(503, { error: { message: 'upstream down', code: 'server_error' } }));
    await expect(provider({ 'openRouter.retries': 1 }).classify(input)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_ERROR', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toContain('status=503');
    assertSafeLogs();
  });

  it('retries timeouts and reports the configured timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValue(timeout);
    await expect(provider({ 'openRouter.retries': 1, 'openRouter.timeoutMs': 20000 }).classify(input)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toContain('timeoutMs=20000');
    expect(warnings()).toContain('timed out after 20000ms');
    assertSafeLogs();
  });

  it('does not retry a malformed model response or invent a classification', async () => {
    fetchMock.mockResolvedValue(response(200, completion('not json')));
    await expect(provider({ 'openRouter.retries': 2 }).classify(input)).rejects.toMatchObject({ code: 'PARSE_ERROR', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('malformed classification');
    assertSafeLogs();
  });

  it('normalizes a null investor type from the model without inventing a strategy', async () => {
    fetchMock.mockResolvedValueOnce(response(200, completion({ ...classification, investorType: null })));
    await expect(provider().classify(input)).resolves.toMatchObject({ investorType: 'NOT_DETERMINED', decision: 'QUALIFIED' });
  });

  it('rejects an unexpected investor type and does not return a qualified lead', async () => {
    fetchMock.mockResolvedValueOnce(response(200, completion({ ...classification, investorType: 'ESTATE_AGENT' })));
    await expect(provider({ 'openRouter.retries': 2 }).classify(input)).rejects.toMatchObject({ code: 'PARSE_ERROR', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('returned=ESTATE_AGENT');
    expect(warnings()).toContain('expected=CASH_HOME_BUYER,FIX_AND_FLIP,BUY_AND_HOLD,BRRRR,COMMERCIAL_INVESTOR,LAND_INVESTOR,MULTIFAMILY_INVESTOR,REAL_ESTATE_INVESTOR_OTHER,NOT_DETERMINED');
    assertSafeLogs();
  });

  it('does not retry an invalid classification request', async () => {
    fetchMock.mockResolvedValue(response(400, { error: { message: 'response_format unsupported', code: 'invalid_request' } }));
    await expect(provider({ 'openRouter.retries': 2 }).classify(input)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST', retryable: false, parserCategory: 'UNSUPPORTED_RESPONSE_FORMAT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('parserCategory=UNSUPPORTED_RESPONSE_FORMAT');
    expect(warnings()).toContain('contentType=application/json');
    assertSafeLogs();
  });

  it('does not retry an empty structured response', async () => {
    fetchMock.mockResolvedValue(response(200, { choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    await expect(provider({ 'openRouter.retries': 2 }).classify(input)).rejects.toMatchObject({ parserCategory: 'EMPTY_RESPONSE', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('finishReason=length');
    expect(warnings()).toContain('parserCategory=EMPTY_RESPONSE');
    assertSafeLogs();
  });

  it('reads markdown JSON and object content from the structured response path', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { choices: [{ finish_reason: 'stop', message: { content: `\`\`\`json\n${JSON.stringify(classification)}\n\`\`\`` } }] }));
    await expect(provider().classify(input)).resolves.toMatchObject({ decision: 'QUALIFIED', investorType: 'CASH_HOME_BUYER' });
    fetchMock.mockResolvedValueOnce(response(200, { choices: [{ finish_reason: 'stop', message: { content: classification } }] }));
    await expect(provider().classify(input)).resolves.toMatchObject({ decision: 'QUALIFIED' });
    fetchMock.mockResolvedValueOnce(response(200, { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: JSON.stringify(classification) }] } }] }));
    await expect(provider().classify(input)).resolves.toMatchObject({ positiveEvidence: [{ evidenceId: 'evidence-1', reason: '' }] });
  });
});
