export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',

  port: parseInt(process.env.PORT ?? '3000', 10),

  apiPrefix: process.env.API_PREFIX ?? 'api/v1',

  metrics: {
    enabled: process.env.METRICS_ENABLED !== 'false',
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://localhost:5173',

  throttler: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },

  outbound: {
    timeoutMs: parseInt(process.env.OUTBOUND_TIMEOUT_MS ?? '10000', 10),
    retries: parseInt(process.env.OUTBOUND_RETRIES ?? '2', 10),
  },

  sourceProvider: {
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,
    googlePlacesBaseUrl: process.env.GOOGLE_PLACES_BASE_URL,
    timeoutMs: parseInt(process.env.SOURCE_PROVIDER_TIMEOUT_MS ?? '10000', 10),
    concurrency: parseInt(process.env.SOURCE_PROVIDER_CONCURRENCY ?? '2', 10),
    maxPages: parseInt(process.env.SOURCE_PROVIDER_MAX_PAGES ?? '3', 10),
    provider: process.env.SOURCE_PROVIDER ?? 'google_places',
    retainRawData: process.env.SOURCE_PROVIDER_RETAIN_RAW_DATA !== 'false',
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS ?? '20000', 10),
    retries: parseInt(process.env.OPENROUTER_RETRIES ?? '2', 10),
  },

  contactProvider: {
    apiKey: process.env.CONTACT_PROVIDER_API_KEY,
    emailApiKey: process.env.EMAIL_ENRICHMENT_API_KEY,
  },

  decisionMaker: {
    rolePriorities: (process.env.DECISION_MAKER_ROLE_PRIORITIES ?? 'CEO,FOUNDER,CO_FOUNDER,PRESIDENT,OWNER,MANAGING_PARTNER,PARTNER,PRINCIPAL,MANAGING_DIRECTOR,DIRECTOR,GENERAL_MANAGER,MANAGER').split(',').map((role) => role.trim().toUpperCase()).filter(Boolean),
  },

  verification: {
    sourcePriorities: (() => {
      try {
        const parsed = JSON.parse(process.env.VERIFICATION_SOURCE_PRIORITIES_JSON ?? '{}');
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    })(),
    reVerifyAfterDays: parseInt(process.env.VERIFICATION_REVERIFY_AFTER_DAYS ?? '30', 10),
  },

  website: {
    fetchTimeoutMs: parseInt(process.env.WEBSITE_FETCH_TIMEOUT_MS ?? '10000', 10),
    maxResponseBytes: parseInt(process.env.WEBSITE_MAX_RESPONSE_BYTES ?? '5000000', 10),
    fetchConcurrency: parseInt(process.env.WEBSITE_FETCH_CONCURRENCY ?? '2', 10),
    maxPagesPerCompany: parseInt(process.env.WEBSITE_MAX_PAGES_PER_COMPANY ?? '5', 10),
    maxCrawlDepth: parseInt(process.env.WEBSITE_MAX_CRAWL_DEPTH ?? '1', 10),
    maxRedirects: parseInt(process.env.WEBSITE_MAX_REDIRECTS ?? '5', 10),
    retries: parseInt(process.env.WEBSITE_FETCH_RETRIES ?? '2', 10),
    respectRobots: process.env.WEBSITE_RESPECT_ROBOTS !== 'false',
  },

  export: {
    storagePath: process.env.EXPORT_STORAGE_PATH ?? './storage/exports',
    retentionDays: parseInt(process.env.EXPORT_RETENTION_DAYS ?? '7', 10),
  },

  usage: {
    requestsPerMinute: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_PER_MINUTE ?? '100', 10),
    requestsPerHour: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_PER_HOUR ?? '1000', 10),
    requestsPerDay: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_PER_DAY ?? '5000', 10),
    aiRequestsPerMinute: parseInt(process.env.AI_REQUESTS_PER_MINUTE ?? '20', 10),
    aiRequestsPerDay: parseInt(process.env.AI_REQUESTS_PER_DAY ?? '500', 10),
    dailySearchLimit: parseInt(process.env.DEFAULT_DAILY_SEARCH_LIMIT ?? '100', 10),
    dailyExportLimit: parseInt(process.env.DEFAULT_DAILY_EXPORT_LIMIT ?? '25', 10),
    dailyAiLimit: parseInt(process.env.DEFAULT_DAILY_AI_LIMIT ?? '500', 10),
    maxLeadsPerSearch: parseInt(process.env.DEFAULT_MAX_LEADS_PER_SEARCH ?? '1000', 10),
    maxExportRows: parseInt(process.env.DEFAULT_MAX_EXPORT_ROWS ?? '10000', 10),
    rateLimitWindowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS ?? '60', 10),
    pricing: (() => {
      try {
        const parsed = JSON.parse(process.env.USAGE_PROVIDER_PRICING_JSON ?? '{}');
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    })(),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
  },
});

export function validateEnvironment(config: Record<string, unknown>) {
  const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const port = Number(config.PORT ?? 3000);
  const throttlerLimit = Number(config.THROTTLE_LIMIT ?? 100);
  const throttlerTtl = Number(config.THROTTLE_TTL ?? 60000);
  const nodeEnv = typeof config.NODE_ENV === 'string' ? config.NODE_ENV : 'development';
  const corsOrigin = typeof config.CORS_ORIGIN === 'string'
    ? config.CORS_ORIGIN
    : 'http://localhost:3000,http://localhost:5173';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (!Number.isInteger(throttlerLimit) || throttlerLimit < 1) {
    throw new Error('THROTTLE_LIMIT must be a positive integer');
  }

  if (!Number.isInteger(throttlerTtl) || throttlerTtl < 1) {
    throw new Error('THROTTLE_TTL must be a positive integer');
  }

  if (nodeEnv === 'production' && corsOrigin === '*') {
    throw new Error('CORS_ORIGIN cannot be "*" in production');
  }

  if (nodeEnv === 'production') {
    const sourceProvider = typeof config.SOURCE_PROVIDER === 'string' ? config.SOURCE_PROVIDER : 'google_places';
    if (sourceProvider === 'fake' || sourceProvider === 'fake_source') {
      throw new Error('SOURCE_PROVIDER=fake is not allowed in production');
    }
    if (sourceProvider === 'google_places' && !config.GOOGLE_PLACES_API_KEY) {
      throw new Error('GOOGLE_PLACES_API_KEY is required when SOURCE_PROVIDER=google_places in production');
    }
    if (!config.OPENROUTER_API_KEY || !config.OPENROUTER_MODEL) {
      throw new Error('OPENROUTER_API_KEY and OPENROUTER_MODEL are required in production');
    }
  }

  if (typeof config.JWT_SECRET !== 'string' || config.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  if (typeof config.JWT_EXPIRES_IN !== 'undefined' && typeof config.JWT_EXPIRES_IN !== 'string') {
    throw new Error('JWT_EXPIRES_IN must be a string');
  }

  const websiteFetchTimeoutMs = Number(config.WEBSITE_FETCH_TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(websiteFetchTimeoutMs) || websiteFetchTimeoutMs < 1000 || websiteFetchTimeoutMs > 60000) {
    throw new Error('WEBSITE_FETCH_TIMEOUT_MS must be an integer between 1000 and 60000');
  }

  const websiteMaxResponseBytes = Number(config.WEBSITE_MAX_RESPONSE_BYTES ?? 5000000);
  if (!Number.isInteger(websiteMaxResponseBytes) || websiteMaxResponseBytes < 10000 || websiteMaxResponseBytes > 100000000) {
    throw new Error('WEBSITE_MAX_RESPONSE_BYTES must be between 10000 and 100000000');
  }

  const websiteFetchConcurrency = Number(config.WEBSITE_FETCH_CONCURRENCY ?? 2);
  if (!Number.isInteger(websiteFetchConcurrency) || websiteFetchConcurrency < 1 || websiteFetchConcurrency > 10) {
    throw new Error('WEBSITE_FETCH_CONCURRENCY must be between 1 and 10');
  }

  const websiteMaxPagesPerCompany = Number(config.WEBSITE_MAX_PAGES_PER_COMPANY ?? 5);
  if (!Number.isInteger(websiteMaxPagesPerCompany) || websiteMaxPagesPerCompany < 1 || websiteMaxPagesPerCompany > 25) {
    throw new Error('WEBSITE_MAX_PAGES_PER_COMPANY must be between 1 and 25');
  }

  return config;
}