import { Writable } from 'node:stream';
import { pino } from 'pino';
import { LOG_REDACT_PATHS } from '../app.module.js';
import { validateEnv } from './env.js';

/** T070 — no tokens, cookies or one-time codes in logs (constitution: security constraints). */
describe('log redaction', () => {
  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = pino({ redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } }, stream);
    return { logger, output: () => lines.join('') };
  }

  it('redacts auth headers, cookies, tokens and codes', () => {
    const { logger, output } = capture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer SECRET-ACCESS', cookie: 'rt=SECRET-COOKIE' } },
        res: { headers: { 'set-cookie': 'rt=SECRET-SETCOOKIE' } },
        body: { refreshToken: 'SECRET-REFRESH', code: '424242', accessToken: 'SECRET-JWT' },
      },
      'request',
    );
    const out = output();
    for (const secret of ['SECRET-ACCESS', 'SECRET-COOKIE', 'SECRET-SETCOOKIE', 'SECRET-REFRESH', '424242', 'SECRET-JWT']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
});

describe('env validation', () => {
  const base = {
    PUBLIC_URL: 'https://api.example.com',
    WEB_ORIGIN: 'https://app.example.com',
    DATABASE_URL: 'postgresql://u:p@db:5432/chat',
    REDIS_URL: 'redis://redis:6379',
    JWT_SECRET: 'x'.repeat(48),
    OTP_PEPPER: 'y'.repeat(24),
    S3_ENDPOINT: 'https://s3.example.com',
    S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 'b',
  };

  it('refuses the log SMS sender in production (codes would be logged)', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/SMS_PROVIDER/);
  });

  it('allows the log SMS sender in production only with the explicit staging flag', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', ALLOW_LOG_SMS: 'false' })).toThrow(
      /SMS_PROVIDER/,
    );
    expect(validateEnv({ ...base, NODE_ENV: 'production', ALLOW_LOG_SMS: 'true' })).toMatchObject({
      SMS_PROVIDER: 'log',
      ALLOW_LOG_SMS: true,
    });
  });

  it('parses TRUST_PROXY as a hop count when numeric', () => {
    expect(validateEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(validateEnv(base).TRUST_PROXY).toBe('loopback');
  });

  it('accepts an AWS S3 config without S3_ENDPOINT', () => {
    const { S3_ENDPOINT: _omit, ...aws } = base;
    const env = validateEnv({ ...aws, S3_REGION: 'eu-central-1' });
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_REGION).toBe('eu-central-1');
  });

  it('refuses short JWT secrets', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('accepts a complete development config', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'development' })).toMatchObject({ PORT: 3000 });
  });
});
