export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',

  port: parseInt(process.env.PORT ?? '3000', 10),

  apiPrefix: process.env.API_PREFIX ?? 'api/v1',

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
  },
});