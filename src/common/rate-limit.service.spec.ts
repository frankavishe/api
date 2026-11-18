import { RateLimitService } from './rate-limit.service.js';

/** Minimal in-memory stand-in for the ioredis commands RateLimitService uses. */
class FakeRedis {
  private store = new Map<string, { value: number; expiresAt: number }>();
  now = 0;

  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async set(key: string, value: string, _ex: 'EX', seconds: number, _nx: 'NX') {
    if (this.live(key)) return null;
    this.store.set(key, { value: Number(value), expiresAt: this.now + seconds * 1000 });
    return 'OK';
  }

  async incr(key: string) {
    const e = this.live(key);
    if (!e) {
      this.store.set(key, { value: 1, expiresAt: Number.POSITIVE_INFINITY });
      return 1;
    }
    e.value += 1;
    return e.value;
  }

  async pttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    return Number.isFinite(e.expiresAt) ? e.expiresAt - this.now : -1;
  }
}

describe('RateLimitService', () => {
  let redis: FakeRedis;
  let limiter: RateLimitService;

  beforeEach(() => {
    redis = new FakeRedis();
    limiter = new RateLimitService(redis as never);
  });

  it('allows requests up to the limit within a window', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
    }
  });

  it('blocks the request after the limit and reports retryAfter in whole seconds', async () => {
    for (let i = 0; i < 3; i++) await limiter.hit('k', 3, 60);
    redis.now = 10_500;
    const res = await limiter.hit('k', 3, 60);
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBe(50);
  });

  it('resets after the window expires', async () => {
    for (let i = 0; i < 4; i++) await limiter.hit('k', 3, 60);
    redis.now = 60_001;
    expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
  });

  it('keeps separate counters per key', async () => {
    await limiter.hit('a', 1, 60);
    expect((await limiter.hit('a', 1, 60)).allowed).toBe(false);
    expect((await limiter.hit('b', 1, 60)).allowed).toBe(true);
  });

  it('consume() throws a 429 RATE_LIMITED error with retryAfter when blocked', async () => {
    await limiter.consume('k', 1, 60);
    await expect(limiter.consume('k', 1, 60)).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED', details: { retryAfter: 60 } },
    });
  });
});
