import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  PRICE_FEED: z.enum(['coinbase', 'mock']).default('coinbase'),
});

export type Config = z.infer<typeof envSchema> & { isProduction: boolean };

/** Fail fast at startup with a readable message instead of crashing later. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return { ...result.data, isProduction: result.data.NODE_ENV === 'production' };
}
