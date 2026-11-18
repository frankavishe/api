import { createTestApp, newPhone, signIn, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';

const rtCookie = (cookies: string[]) => cookies.find((c) => c.startsWith('rt='));

/** T051 — web sign-in (US3): HttpOnly refresh cookie, no account creation, CORS. */
describe('Auth (web)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  async function existingAccount() {
    const phone = newPhone();
    await signIn(t, phone, 'android');
    await t.redis.flushdb();
    return phone;
  }

  it('signs in as a web device with the refresh token only in an HttpOnly cookie', async () => {
    const phone = await existingAccount();
    const { body, cookies } = await signIn(t, phone, 'web');
    expectContract('AuthResult', body);
    expect(body.refreshToken).toBeUndefined();
    expect(body.isNewAccount).toBe(false);
    expect(body.device).toMatchObject({ type: 'web', current: true });

    const cookie = rtCookie(cookies);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
  });

  it('refreshes with the cookie and rotates it', async () => {
    const phone = await existingAccount();
    const { cookies } = await signIn(t, phone, 'web');
    const cookie = rtCookie(cookies)!.split(';')[0];

    const res = await t.http.post('/v1/auth/refresh').set('Cookie', cookie).expect(200);
    expectContract('TokenPair', res.body);
    expect(res.body.refreshToken).toBeUndefined();
    const next = rtCookie(([] as string[]).concat(res.headers['set-cookie'] ?? []))!.split(';')[0];
    expect(next).not.toBe(cookie);

    // The old cookie is now a reused token.
    await t.http.post('/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('does not create accounts: unknown number → ACCOUNT_NOT_FOUND after a correct code', async () => {
    const phone = newPhone();
    await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
    const res = await t.http
      .post('/v1/auth/verify')
      .send({ phone, code: t.sms.lastCode(phone), deviceType: 'web', deviceName: 'Chrome' })
      .expect(404);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a wrong code on web is INVALID_CODE, never ACCOUNT_NOT_FOUND (no enumeration)', async () => {
    const phone = newPhone();
    await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
    const wrong = t.sms.lastCode(phone) === '000000' ? '111111' : '000000';
    const res = await t.http
      .post('/v1/auth/verify')
      .send({ phone, code: wrong, deviceType: 'web', deviceName: 'Chrome' })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CODE');
  });

  it('allows credentialed CORS from the web origin only', async () => {
    const ok = await t.http
      .options('/v1/auth/refresh')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const bad = await t.http
      .options('/v1/auth/refresh')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    // The browser blocks the response because the allowed origin does not match.
    expect(bad.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(bad.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('sign-out clears the cookie', async () => {
    const phone = await existingAccount();
    const { body } = await signIn(t, phone, 'web');
    const res = await t.http
      .post('/v1/auth/sign-out')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(204);
    expect(rtCookie(([] as string[]).concat(res.headers['set-cookie'] ?? []))).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
