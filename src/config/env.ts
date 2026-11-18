import { z } from 'zod';

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters`);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_URL: z.url(),
    WEB_ORIGIN: z.url(),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL'),
    REDIS_URL: z.string().startsWith('redis://'),
    JWT_SECRET: secret('JWT_SECRET'),
    OTP_PEPPER: z.string().min(16),
    /** `log` writes codes to the API log and is refused in production unless ALLOW_LOG_SMS=true. */
    SMS_PROVIDER: z.enum(['log']).default('log'),
    /**
     * Staging/demo escape hatch: lets a production build use the `log` SMS provider so codes
     * can be read from the host's logs. Never enable for real users.
     */
    ALLOW_LOG_SMS: z.stringbool().default(false),
    /**
     * Express `trust proxy` setting (affects req.ip and per-IP rate limits). A number is a hop
     * count (e.g. `1` behind Render's load balancer); anything else is passed through as-is.
     */
    TRUST_PROXY: z
      .string()
      .default('loopback')
      .transform((v) => (/^\d+$/.test(v) ? Number(v) : v)),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET_AVATARS: z.string().default('avatars'),
  })
  .refine(
    (e) => !(e.NODE_ENV === 'production' && e.SMS_PROVIDER === 'log' && !e.ALLOW_LOG_SMS),
    {
      message:
        'SMS_PROVIDER=log would write one-time codes to logs; it is not allowed in production (set ALLOW_LOG_SMS=true only for a staging/demo deploy)',
      path: ['SMS_PROVIDER'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const res = envSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return res.data;
}
