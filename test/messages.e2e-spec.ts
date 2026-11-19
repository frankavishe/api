import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { connected, createTestApp, nextEvent, signIn, type TestApp } from './support/app.js';
import { expectContract, expectEvent } from './support/contract.js';
import {
  addWebDevice,
  auth,
  directChat,
  fakeCipher,
  newUser,
  type TestDevice,
} from './support/e2ee.js';

/** Feature 002 — multi-device envelope delivery. */
describe('Messages', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.get(PrismaService);
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  const envelope = (to: TestDevice, text = 'hi', type: 'prekey' | 'whisper' = 'prekey') => ({
    deviceId: to.deviceId,
    type,
    ciphertext: fakeCipher(text),
  });
  const send = (from: TestDevice, conversationId: string, envelopes: object[]) =>
    t.http.post('/v1/messages').set(auth(from.token)).send({ conversationId, envelopes });
  const ref = (d: TestDevice) => ({ userId: d.userId, deviceId: d.deviceId });
  const byDevice = (a: { deviceId: string }, b: { deviceId: string }) => a.deviceId.localeCompare(b.deviceId);

  it('409s with missing and stale devices and stores nothing', async () => {
    const alice = await newUser(t);
    const aliceWeb = await addWebDevice(t, alice);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const carol = await newUser(t); // not in the conversation
    const id = await directChat(t, alice, bob);

    const res = await send(alice, id, [envelope(bob), envelope(carol)]).expect(409);
    expectContract('DeviceMismatchError', res.body);
    expect(res.body.code).toBe('DEVICE_MISMATCH');
    expect([...res.body.details.missingDevices].sort(byDevice)).toEqual([ref(bobWeb), ref(aliceWeb)].sort(byDevice));
    expect(res.body.details.staleDevices).toEqual([ref(carol)]);
    expect(await prisma.envelope.count({ where: { conversationId: id } })).toBe(0);
  });

  it('delivers to every device, including sync copies to the sender’s other devices', async () => {
    const alice = await newUser(t);
    const aliceWeb = await addWebDevice(t, alice);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const id = await directChat(t, alice, bob);

    const sockets = [bob, bobWeb, aliceWeb].map((d) => t.socket(d.token));
    await Promise.all(sockets.map((s) => connected(s)));
    const events = sockets.map((s) => nextEvent<{ id: string; senderDeviceId: string }>(s, 'envelope:new'));

    const envs = [envelope(bob), envelope(bobWeb), envelope(aliceWeb, 'sync', 'whisper')];
    const res = await send(alice, id, envs).expect(200);
    expectContract('SendMessageResult', res.body);

    const received = await Promise.all(events);
    received.forEach((e, i) => {
      expectEvent('envelope:new', e);
      expect(e).toMatchObject({
        conversationId: id,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        type: envs[i].type,
        ciphertext: envs[i].ciphertext,
        serverTimestamp: res.body.serverTimestamp,
      });
    });
  });

  it('lists pending envelopes oldest first, and ack deletes them', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    const sent = [];
    for (const text of ['one', 'two', 'three']) {
      const env = envelope(bob, text);
      sent.push(env.ciphertext);
      await send(alice, id, [env]).expect(200);
    }

    const pending = await t.http.get('/v1/envelopes').set(auth(bob.token)).expect(200);
    expectContract('Envelope', pending.body, { array: true });
    expect(pending.body.map((e: { ciphertext: string }) => e.ciphertext)).toEqual(sent);
    const limited = await t.http.get('/v1/envelopes').query({ limit: 2 }).set(auth(bob.token)).expect(200);
    expect(limited.body).toHaveLength(2);
    await t.http.get('/v1/envelopes').query({ limit: 0 }).set(auth(bob.token)).expect(400);

    // Alice cannot ack Bob's envelopes; unknown ids are ignored.
    const ids = pending.body.map((e: { id: string }) => e.id);
    await t.http.post('/v1/envelopes/ack').set(auth(alice.token)).send({ ids }).expect(204);
    expect(await prisma.envelope.count({ where: { id: { in: ids } } })).toBe(3);

    await t.http
      .post('/v1/envelopes/ack')
      .set(auth(bob.token))
      .send({ ids: [ids[0], ids[1], uuidv7()] })
      .expect(204);
    const left = await t.http.get('/v1/envelopes').set(auth(bob.token)).expect(200);
    expect(left.body.map((e: { id: string }) => e.id)).toEqual([ids[2]]);
    expect(await prisma.envelope.count({ where: { id: { in: ids.slice(0, 2) } } })).toBe(0);
  });

  it('rejects non-members and unknown conversations', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const mallory = await newUser(t);
    const id = await directChat(t, alice, bob);
    const res = await send(mallory, id, [envelope(bob)]).expect(403);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    const missing = await send(alice, uuidv7(), []).expect(404);
    expect(missing.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('validates envelopes', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    await send(alice, id, [envelope(bob), envelope(bob)]).expect(400); // duplicate device
    await send(alice, id, [{ ...envelope(bob), type: 'plain' }]).expect(400);
    await send(alice, id, [{ ...envelope(bob), ciphertext: 'not base64!' }]).expect(400);
    const unknown = await send(alice, id, [envelope(bob), { ...envelope(bob), deviceId: uuidv7() }]).expect(400);
    expect(unknown.body.code).toBe('VALIDATION_FAILED');
  });

  it('allows an empty batch when nobody else needs a copy', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t, { keys: false }); // no keys yet, so no device to address
    const id = await directChat(t, alice, bob);
    await send(alice, id, []).expect(200);
  });

  it('a revoked device loses its envelopes and keys, and becomes stale', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const id = await directChat(t, alice, bob);
    await send(alice, id, [envelope(bob), envelope(bobWeb)]).expect(200);
    expect(await prisma.envelope.count({ where: { recipientDeviceId: bobWeb.deviceId } })).toBe(1);

    await t.http.delete(`/v1/devices/${bobWeb.deviceId}`).set(auth(bob.token)).expect(204);
    expect(await prisma.envelope.count({ where: { recipientDeviceId: bobWeb.deviceId } })).toBe(0);
    expect(await prisma.deviceKeys.count({ where: { deviceId: bobWeb.deviceId } })).toBe(0);

    const res = await send(alice, id, [envelope(bob), envelope(bobWeb)]).expect(409);
    expect(res.body.details).toEqual({ missingDevices: [], staleDevices: [ref(bobWeb)] });
  });

  it('replacing the Android device purges the old one', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    await send(alice, id, [envelope(bob)]).expect(200);
    await signIn(t, bob.phone, 'android', 'New phone');
    expect(await prisma.envelope.count({ where: { recipientDeviceId: bob.deviceId } })).toBe(0);
    expect(await prisma.deviceKeys.count({ where: { deviceId: bob.deviceId } })).toBe(0);
  });

  it('answers 413 PAYLOAD_TOO_LARGE for an oversized body', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    const big = randomBytes(65_536).toString('base64'); // 87 384 chars, the per-envelope maximum
    const envelopes = Array.from({ length: 400 }, () => ({ deviceId: bob.deviceId, type: 'whisper', ciphertext: big }));
    const res = await send(alice, id, envelopes).expect(413);
    expectContract('Error', res.body);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a body well above the default 100 kb JSON limit', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const id = await directChat(t, alice, bob);
    const ciphertext = randomBytes(65_536).toString('base64');
    // Two maximum-size envelopes: about 175 kB of JSON.
    await send(alice, id, [bob, bobWeb].map((d) => ({ deviceId: d.deviceId, type: 'prekey', ciphertext }))).expect(200);
    const pending = await t.http.get('/v1/envelopes').set(auth(bobWeb.token)).expect(200);
    expect(pending.body[0].ciphertext).toBe(ciphertext);
  });

  it('rate-limits sending', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    await t.redis.set(`rl:msg:${alice.deviceId}`, '300', 'EX', 60);
    const res = await send(alice, id, [envelope(bob)]).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});
