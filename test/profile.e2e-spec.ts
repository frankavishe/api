import sharp from 'sharp';
import { connected, createTestApp, newPhone, nextEvent, signIn, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';

/** T043 — profile and avatars (US2, FR-011, FR-012). */
describe('Profile', () => {
  let t: TestApp;
  let png: Buffer;

  beforeAll(async () => {
    t = await createTestApp();
    png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 120, b: 90 } },
    })
      .png()
      .toBuffer();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('GET /me returns the incomplete profile of a new account', async () => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http.get('/v1/me').set(auth(body.accessToken)).expect(200);
    expectContract('Me', res.body);
    expect(res.body).toMatchObject({ displayName: null, profileComplete: false, avatarUrl: null });
  });

  it('PATCH /me sets name and about and completes the profile', async () => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http
      .patch('/v1/me')
      .set(auth(body.accessToken))
      .send({ displayName: '  Frank  ', about: 'Available' })
      .expect(200);
    expectContract('Me', res.body);
    expect(res.body).toMatchObject({ displayName: 'Frank', about: 'Available', profileComplete: true });
  });

  it.each([
    [{ displayName: '' }],
    [{ displayName: '   ' }],
    [{ displayName: 'x'.repeat(26) }],
    [{ about: 'x'.repeat(141) }],
    [{}],
    [{ phone: '+255700000000' }],
  ])('PATCH /me rejects %j', async (patch) => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http.patch('/v1/me').set(auth(body.accessToken)).send(patch).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('uploads an avatar, crops it to a 640px square WebP and serves it publicly', async () => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http
      .put('/v1/me/avatar')
      .set(auth(body.accessToken))
      .attach('file', png, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);
    expectContract('Me', res.body);
    expect(res.body.avatarUrl).toMatch(/\/v1\/avatars\/[\w-]+\.webp$/);

    for (const [url, size] of [
      [res.body.avatarUrl, 640],
      [res.body.avatarThumbUrl, 96],
    ] as const) {
      const path = new URL(url).pathname;
      const img = await t.http.get(path).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/webp');
      expect(img.headers['cache-control']).toContain('immutable');
      const meta = await sharp(img.body as Buffer).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: size, height: size });
    }
  });

  it('rejects non-images even when they claim to be PNG', async () => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http
      .put('/v1/me/avatar')
      .set(auth(body.accessToken))
      .attach('file', Buffer.from('not an image at all'), { filename: 'x.png', contentType: 'image/png' })
      .expect(415);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects avatars over 5 MB with 413', async () => {
    const { body } = await signIn(t, newPhone());
    const res = await t.http
      .put('/v1/me/avatar')
      .set(auth(body.accessToken))
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 1), { filename: 'big.png', contentType: 'image/png' })
      .expect(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('DELETE /me/avatar removes the photo', async () => {
    const { body } = await signIn(t, newPhone());
    const up = await t.http
      .put('/v1/me/avatar')
      .set(auth(body.accessToken))
      .attach('file', png, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);
    const res = await t.http.delete('/v1/me/avatar').set(auth(body.accessToken)).expect(200);
    expect(res.body.avatarUrl).toBeNull();
    await t.http.get(new URL(up.body.avatarUrl).pathname).expect(404);
  });

  it('GET /avatars/:key returns 404 for unknown or malformed keys', async () => {
    await t.http.get('/v1/avatars/0192f8a0-0000-7000-8000-000000000000.webp').expect(404);
    await t.http.get('/v1/avatars/..%2F..%2Fetc.webp').expect(404);
  });

  it('pushes profile:updated to the user’s other devices', async () => {
    const phone = newPhone();
    const android = await signIn(t, phone);
    await t.redis.flushdb();
    const web = await signIn(t, phone, 'web');
    const webSocket = t.socket(web.body.accessToken);
    await connected(webSocket);
    const update = nextEvent<{ id: string; displayName: string }>(webSocket, 'profile:updated');

    await t.http
      .patch('/v1/me')
      .set(auth(android.body.accessToken))
      .send({ displayName: 'New Name' })
      .expect(200);
    await expect(update).resolves.toMatchObject({ id: android.body.user.id, displayName: 'New Name' });
  });
});
