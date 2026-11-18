import { connected, createTestApp, newPhone, nextEvent, signIn, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';

/** T057 — device list and remote sign-out (US4, FR-008, FR-009, SC-003). */
describe('Devices', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function phoneAndBrowser() {
    const phone = newPhone();
    const android = await signIn(t, phone, 'android');
    await t.redis.flushdb();
    const web = await signIn(t, phone, 'web', 'Firefox on Linux');
    return { android: android.body, web: web.body };
  }

  it('lists active devices and flags the current one', async () => {
    const { android, web } = await phoneAndBrowser();
    const res = await t.http.get('/v1/devices').set(auth(android.accessToken)).expect(200);
    expectContract('Device', res.body, { array: true });
    expect(res.body).toHaveLength(2);
    const byId = Object.fromEntries(res.body.map((d: { id: string }) => [d.id, d]));
    expect(byId[android.device.id]).toMatchObject({ type: 'android', current: true });
    expect(byId[web.device.id]).toMatchObject({ type: 'web', name: 'Firefox on Linux', current: false });
  });

  it('signs out a remote device: it gets device:revoked and loses access', async () => {
    const { android, web } = await phoneAndBrowser();
    const browser = t.socket(web.accessToken);
    await connected(browser);
    const revoked = nextEvent(browser, 'device:revoked');
    const started = Date.now();

    await t.http.delete(`/v1/devices/${web.device.id}`).set(auth(android.accessToken)).expect(204);

    await expect(revoked).resolves.toEqual({ deviceId: web.device.id, reason: 'signed_out' });
    expect(Date.now() - started).toBeLessThan(10_000);
    const res = await t.http.get('/v1/me').set(auth(web.accessToken)).expect(401);
    expect(res.body.code).toBe('SESSION_REVOKED');

    const list = await t.http.get('/v1/devices').set(auth(android.accessToken)).expect(200);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([android.device.id]);
  });

  it('a revoked device cannot open a socket', async () => {
    const { android, web } = await phoneAndBrowser();
    await t.http.delete(`/v1/devices/${web.device.id}`).set(auth(android.accessToken)).expect(204);
    await expect(connected(t.socket(web.accessToken))).rejects.toMatchObject({
      data: { code: 'SESSION_REVOKED' },
    });
  });

  it('cannot sign out another user’s device', async () => {
    const a = await phoneAndBrowser();
    await t.redis.flushdb();
    const b = await phoneAndBrowser();
    const res = await t.http.delete(`/v1/devices/${b.web.device.id}`).set(auth(a.android.accessToken)).expect(404);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('can sign out the current device', async () => {
    const { android } = await phoneAndBrowser();
    await t.http.delete(`/v1/devices/${android.device.id}`).set(auth(android.accessToken)).expect(204);
    await t.http.get('/v1/devices').set(auth(android.accessToken)).expect(401);
  });

  it('validates the device id', async () => {
    const { android } = await phoneAndBrowser();
    await t.http.delete('/v1/devices/not-a-uuid').set(auth(android.accessToken)).expect(400);
  });
});
