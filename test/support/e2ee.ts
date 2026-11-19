import { createCipheriv, randomBytes } from 'node:crypto';
import { newPhone, signIn, type TestApp } from './app.js';

/** Fake Signal key material and ciphertext. The server never inspects either beyond shape. */

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 33-byte Curve25519 public key with the 0x05 prefix, base64 (44 chars). */
export function fakePublicKey(): string {
  const b = randomBytes(33);
  b[0] = 0x05;
  return b.toString('base64');
}

export function fakePreKeys(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({ keyId: startId + i, publicKey: fakePublicKey() }));
}

export function keyUpload(opts: { preKeys?: number; startId?: number; identityKey?: string } = {}) {
  return {
    registrationId: 1 + Math.floor(Math.random() * 16_000),
    identityKey: opts.identityKey ?? fakePublicKey(),
    signedPreKey: { keyId: 1, publicKey: fakePublicKey(), signature: randomBytes(64).toString('base64') },
    preKeys: fakePreKeys(opts.preKeys ?? 20, opts.startId),
  };
}

export async function uploadKeys(t: TestApp, token: string, preKeys = 20) {
  const body = keyUpload({ preKeys });
  await t.http.put('/v1/keys').set(auth(token)).send(body).expect(204);
  return body;
}

/** Stands in for a Signal message: AES-256-GCM under a key the server never sees. */
export function fakeCipher(plaintext: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export interface TestDevice {
  userId: string;
  deviceId: string;
  token: string;
  phone: string;
}

/** A new account signed in on Android, optionally with keys uploaded. */
export async function newUser(t: TestApp, opts: { keys?: boolean } = {}): Promise<TestDevice> {
  const phone = newPhone();
  const { body } = await signIn(t, phone, 'android');
  await t.redis.flushdb();
  const dev = { userId: body.user.id, deviceId: body.device.id, token: body.accessToken, phone };
  if (opts.keys !== false) await uploadKeys(t, dev.token);
  return dev;
}

/** Signs the same account in on a web browser, optionally with keys uploaded. */
export async function addWebDevice(
  t: TestApp,
  owner: TestDevice,
  opts: { keys?: boolean } = {},
): Promise<TestDevice> {
  const { body } = await signIn(t, owner.phone, 'web');
  await t.redis.flushdb();
  const dev = { userId: body.user.id, deviceId: body.device.id, token: body.accessToken, phone: owner.phone };
  if (opts.keys !== false) await uploadKeys(t, dev.token);
  return dev;
}

export async function directChat(t: TestApp, a: TestDevice, b: TestDevice): Promise<string> {
  const res = await t.http
    .post('/v1/conversations')
    .set(auth(a.token))
    .send({ type: 'direct', peerId: b.userId });
  if (res.status !== 201 && res.status !== 200) throw new Error(`direct chat failed: ${res.status}`);
  return res.body.id;
}

/** Resolves true if `event` arrives within `ms`, false otherwise. */
export function receivesWithin(
  socket: { once(e: string, cb: () => void): unknown; off(e: string): unknown },
  event: string,
  ms = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event);
      resolve(false);
    }, ms);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
