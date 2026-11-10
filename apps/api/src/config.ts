import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://globi:globi@localhost:5432/globi'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-dev-only-secret'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
  TRUST_PROXY: z.string().default('loopback'),
  LOG_LEVEL: z.string().default('info'),
  FISCAL_MODE: z.enum(['disabled', 'mock', 'test', 'production']).default('mock'),
});

const parsed = schema.parse(process.env);
if (parsed.NODE_ENV === 'production' && parsed.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('JWT_SECRET duhet vendosur në prodhim');
}
export const config = parsed;
export type Config = typeof parsed;
