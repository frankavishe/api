import { createTestApp, type TestApp } from './support/app.js';

/** GET /v1/dev/last-otp is a development-only helper; it must not exist in other environments. */
describe('Dev OTP endpoint', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('is not registered when NODE_ENV=test', async () => {
    const res = await t.http.get('/v1/dev/last-otp').query({ phone: '+255710000000' }).expect(404);
    expect(res.body.message).toMatch(/Cannot GET/);
  });

  it('reports unknown routes as NOT_FOUND, not USER_NOT_FOUND', async () => {
    const res = await t.http.get('/v1/no-such-route').expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
