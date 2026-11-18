import { connected, createTestApp, newPhone, nextEvent, signIn, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';

/** T032 — HTTP auth flow for Android (US1), checked against contracts/openapi.yaml. */
describe('Auth (android)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  describe('POST /v1/auth/request-code', () => {
    it('returns 202 with timings, for both new and existing numbers', async () => {
      const existing = newPhone();
      await signIn(t, existing);
      await t.redis.flushdb();
      for (const phone of [newPhone(), existing]) {
        const res = await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
        expectContract('RequestCodeResponse', res.body);
        expect(res.body).toEqual({ expiresIn: 300, resendAfter: 60 });
      }
    });

    it('rejects malformed and invalid numbers', async () => {
      const bad = await t.http.post('/v1/auth/request-code').send({ phone: '0712345678' }).expect(400);
      expectContract('Error', bad.body);
      const invalid = await t.http.post('/v1/auth/request-code').send({ phone: '+15550100' }).expect(400);
      expect(invalid.body.code).toBe('INVALID_PHONE');
    });

    it('allows one request per minute per number', async () => {
      const phone = newPhone();
      await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
      const res = await t.http.post('/v1/auth/request-code').send({ phone }).expect(429);
      expectContract('Error', res.body);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits requests per IP address', async () => {
      for (let i = 0; i < 20; i++) {
        await t.http.post('/v1/auth/request-code').send({ phone: newPhone() }).expect(202);
      }
      await t.http.post('/v1/auth/request-code').send({ phone: newPhone() }).expect(429);
    });
  });

  describe('POST /v1/auth/verify (android)', () => {
    it('creates the account and returns tokens, device and user', async () => {
      const phone = newPhone();
      const { body, cookies } = await signIn(t, phone);
      expectContract('AuthResult', body);
      expect(body.isNewAccount).toBe(true);
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.device).toMatchObject({ type: 'android', name: 'Pixel 8', current: true });
      expect(body.user).toMatchObject({ phone, displayName: null, profileComplete: false });
      expect(cookies.some((c) => c.startsWith('rt='))).toBe(false);
    });

    it('signs an existing user back in and signs the old phone out in real time', async () => {
      const phone = newPhone();
      const first = await signIn(t, phone);
      const oldSocket = t.socket(first.body.accessToken);
      await connected(oldSocket);
      const revoked = nextEvent(oldSocket, 'device:revoked');

      await t.redis.del(`rl:otp:phone:${phone}:min`);
      const second = await signIn(t, phone, 'android', 'New phone');
      expect(second.body.isNewAccount).toBe(false);
      expect(second.body.user.id).toBe(first.body.user.id);
      await expect(revoked).resolves.toEqual({ deviceId: first.body.device.id, reason: 'replaced' });

      const res = await t.http
        .get('/v1/devices')
        .set('Authorization', `Bearer ${first.body.accessToken}`)
        .expect(401);
      expect(res.body.code).toBe('SESSION_REVOKED');
    });

    it('returns INVALID_CODE for a wrong code', async () => {
      const phone = newPhone();
      await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
      const code = t.sms.lastCode(phone) === '000000' ? '111111' : '000000';
      const res = await t.http
        .post('/v1/auth/verify')
        .send({ phone, code, deviceType: 'android', deviceName: 'Pixel' })
        .expect(401);
      expectContract('Error', res.body);
      expect(res.body.code).toBe('INVALID_CODE');
    });

    it('validates the body', async () => {
      const res = await t.http
        .post('/v1/auth/verify')
        .send({ phone: newPhone(), code: '12', deviceType: 'ios', deviceName: '' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /v1/auth/refresh and /sign-out (android)', () => {
    it('rotates tokens; the new access token works', async () => {
      const { body } = await signIn(t, newPhone());
      const res = await t.http
        .post('/v1/auth/refresh')
        .send({ refreshToken: body.refreshToken })
        .expect(200);
      expectContract('TokenPair', res.body);
      expect(res.body.refreshToken).not.toBe(body.refreshToken);
      await t.http.get('/v1/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    });

    it('refuses a reused refresh token and kills the session', async () => {
      const { body } = await signIn(t, newPhone());
      const rotated = await t.http.post('/v1/auth/refresh').send({ refreshToken: body.refreshToken }).expect(200);
      const reuse = await t.http.post('/v1/auth/refresh').send({ refreshToken: body.refreshToken }).expect(401);
      expect(reuse.body.code).toBe('SESSION_REVOKED');
      await t.http.post('/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    });

    it('signs out the current device', async () => {
      const { body } = await signIn(t, newPhone());
      await t.http.post('/v1/auth/sign-out').set('Authorization', `Bearer ${body.accessToken}`).expect(204);
      await t.http.get('/v1/me').set('Authorization', `Bearer ${body.accessToken}`).expect(401);
      await t.http.post('/v1/auth/refresh').send({ refreshToken: body.refreshToken }).expect(401);
    });

    it('requires an access token on protected routes', async () => {
      const res = await t.http.get('/v1/me').expect(401);
      expectContract('Error', res.body);
    });
  });

  describe('realtime connection', () => {
    it('rejects sockets without a valid token', async () => {
      const s = t.socket('garbage');
      await expect(connected(s)).rejects.toMatchObject({ data: { code: 'UNAUTHORIZED' } });
    });
  });
});
