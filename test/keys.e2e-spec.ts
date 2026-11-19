import { PrismaService } from '../src/prisma/prisma.service.js';
import { connected, createTestApp, nextEvent, type TestApp } from './support/app.js';
import { expectContract, expectEvent } from './support/contract.js';
import { addWebDevice, auth, fakePreKeys, fakePublicKey, keyUpload, newUser } from './support/e2ee.js';

/** Feature 002 — Signal public key directory. */
describe('Keys', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.get(PrismaService);
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  it('rejects a first upload without a signed prekey', async () => {
    const me = await newUser(t, { keys: false });
    const { signedPreKey: _, ...body } = keyUpload();
    const res = await t.http.put('/v1/keys').set(auth(me.token)).send(body).expect(400);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('KEYS_NOT_UPLOADED');
  });

  it('validates key shapes', async () => {
    const me = await newUser(t, { keys: false });
    const notAKey = Buffer.alloc(33, 1).toString('base64'); // right length, wrong 0x05 prefix
    await t.http.put('/v1/keys').set(auth(me.token)).send(keyUpload({ identityKey: notAKey })).expect(400);
    const tooMany = { ...keyUpload(), preKeys: fakePreKeys(101) };
    await t.http.put('/v1/keys').set(auth(me.token)).send(tooMany).expect(400);
    await t.http
      .put('/v1/keys')
      .set(auth(me.token))
      .send({ ...keyUpload(), extra: true })
      .expect(400);
  });

  it('uploads, counts, tops up and skips duplicate prekeys', async () => {
    const me = await newUser(t, { keys: false });
    const first = keyUpload({ preKeys: 5 });
    await t.http.put('/v1/keys').set(auth(me.token)).send(first).expect(204);
    let res = await t.http.get('/v1/keys/count').set(auth(me.token)).expect(200);
    expectContract('KeyCount', res.body);
    expect(res.body).toEqual({ count: 5 });

    // Top-up with the same identity: no signed prekey needed, duplicate ids ignored.
    await t.http
      .put('/v1/keys')
      .set(auth(me.token))
      .send({
        registrationId: first.registrationId,
        identityKey: first.identityKey,
        preKeys: [...first.preKeys.slice(0, 2), ...fakePreKeys(3, 100)],
      })
      .expect(204);
    res = await t.http.get('/v1/keys/count').set(auth(me.token)).expect(200);
    expect(res.body).toEqual({ count: 8 });
  });

  it('a new identity key replaces all of the device keys', async () => {
    const me = await newUser(t, { keys: false });
    await t.http.put('/v1/keys').set(auth(me.token)).send(keyUpload({ preKeys: 10 })).expect(204);

    const rotated = keyUpload({ preKeys: 3, startId: 500 });
    const { signedPreKey: _, ...withoutSpk } = rotated;
    const bad = await t.http.put('/v1/keys').set(auth(me.token)).send(withoutSpk).expect(400);
    expect(bad.body.code).toBe('KEYS_NOT_UPLOADED');

    await t.http.put('/v1/keys').set(auth(me.token)).send(rotated).expect(204);
    const res = await t.http.get('/v1/keys/count').set(auth(me.token)).expect(200);
    expect(res.body).toEqual({ count: 3 });
    const keys = await prisma.deviceKeys.findUniqueOrThrow({ where: { deviceId: me.deviceId } });
    expect(Buffer.from(keys.identityKey).toString('base64')).toBe(rotated.identityKey);
  });

  it('hands out one bundle per device and consumes one prekey each', async () => {
    const alice = await newUser(t, { keys: false });
    const upload = keyUpload({ preKeys: 12 });
    await t.http.put('/v1/keys').set(auth(alice.token)).send(upload).expect(204);
    const aliceWeb = await addWebDevice(t, alice);
    await addWebDevice(t, alice, { keys: false }); // no keys -> not listed
    const bob = await newUser(t);

    const res = await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(bob.token)).expect(200);
    expectContract('UserKeys', res.body);
    expect(res.body.userId).toBe(alice.userId);
    expect(res.body.devices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual(
      [alice.deviceId, aliceWeb.deviceId].sort(),
    );
    const android = res.body.devices.find((d: { deviceId: string }) => d.deviceId === alice.deviceId);
    expect(android).toMatchObject({
      registrationId: upload.registrationId,
      identityKey: upload.identityKey,
      signedPreKey: upload.signedPreKey,
      preKey: upload.preKeys[0],
    });

    // Second fetch gets the next prekey; the first one is gone for good.
    const again = await t.http
      .get(`/v1/users/${alice.userId}/keys`)
      .query({ deviceId: alice.deviceId })
      .set(auth(bob.token))
      .expect(200);
    expect(again.body.devices).toHaveLength(1);
    expect(again.body.devices[0].preKey).toEqual(upload.preKeys[1]);
    const count = await t.http.get('/v1/keys/count').set(auth(alice.token)).expect(200);
    expect(count.body).toEqual({ count: 10 });
  });

  it('returns preKey null when none are left', async () => {
    const alice = await newUser(t, { keys: false });
    await t.http.put('/v1/keys').set(auth(alice.token)).send(keyUpload({ preKeys: 1 })).expect(204);
    const bob = await newUser(t);
    const first = await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(bob.token)).expect(200);
    expect(first.body.devices[0].preKey).not.toBeNull();
    const second = await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(bob.token)).expect(200);
    expectContract('UserKeys', second.body);
    expect(second.body.devices[0].preKey).toBeNull();
  });

  it('sends prekeys:low to the device when fewer than 10 remain', async () => {
    const alice = await newUser(t, { keys: false });
    await t.http.put('/v1/keys').set(auth(alice.token)).send(keyUpload({ preKeys: 10 })).expect(204);
    const socket = t.socket(alice.token);
    await connected(socket);
    const low = nextEvent(socket, 'prekeys:low');
    const bob = await newUser(t);
    await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(bob.token)).expect(200);
    const payload = await low;
    expectEvent('prekeys:low', payload);
    expect(payload).toEqual({ count: 9 });
  });

  it('leaves out the calling device when fetching your own keys', async () => {
    const alice = await newUser(t);
    const web = await addWebDevice(t, alice);
    const res = await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(alice.token)).expect(200);
    expect(res.body.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([web.deviceId]);
  });

  it('does not list revoked devices and purges their keys', async () => {
    const alice = await newUser(t);
    const web = await addWebDevice(t, alice);
    await t.http.delete(`/v1/devices/${web.deviceId}`).set(auth(alice.token)).expect(204);
    const bob = await newUser(t);
    const res = await t.http.get(`/v1/users/${alice.userId}/keys`).set(auth(bob.token)).expect(200);
    expect(res.body.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([alice.deviceId]);
    expect(await prisma.deviceKeys.count({ where: { deviceId: web.deviceId } })).toBe(0);
    expect(await prisma.oneTimePreKey.count({ where: { deviceId: web.deviceId } })).toBe(0);
    expect(await prisma.signedPreKey.count({ where: { deviceId: web.deviceId } })).toBe(0);
  });

  it('404s for an unknown user and rate-limits bundle fetches', async () => {
    const bob = await newUser(t);
    const res = await t.http
      .get('/v1/users/0190d6c0-0000-7000-8000-000000000000/keys')
      .set(auth(bob.token))
      .expect(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');

    await t.redis.set(`rl:keys:${bob.deviceId}`, '120', 'EX', 3600);
    const limited = await t.http.get(`/v1/users/${bob.userId}/keys`).set(auth(bob.token)).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('rejects public keys of the wrong length', async () => {
    const me = await newUser(t, { keys: false });
    const body = keyUpload();
    body.preKeys[0].publicKey = fakePublicKey().slice(0, 40);
    await t.http.put('/v1/keys').set(auth(me.token)).send(body).expect(400);
  });
});
