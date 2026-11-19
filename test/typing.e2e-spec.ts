import { connected, createTestApp, nextEvent, type TestApp } from './support/app.js';
import { expectEvent } from './support/contract.js';
import { addWebDevice, directChat, newUser, receivesWithin } from './support/e2ee.js';

/** Feature 002 — ephemeral typing relay over the socket. */
describe('Typing', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  it('relays to every device of the other members, not back to the sender', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const id = await directChat(t, alice, bob);

    const [as, bs, bws] = [alice, bob, bobWeb].map((d) => t.socket(d.token));
    await Promise.all([as, bs, bws].map((s) => connected(s)));
    const onBob = nextEvent(bs, 'typing');
    const onBobWeb = nextEvent(bws, 'typing');
    const echoed = receivesWithin(as, 'typing');

    as.emit('typing', { conversationId: id, state: 'start' });

    const payload = await onBob;
    expectEvent('typing', payload);
    expect(payload).toEqual({ conversationId: id, userId: alice.userId, state: 'start' });
    await expect(onBobWeb).resolves.toEqual(payload);
    expect(await echoed).toBe(false);
  });

  it('drops typing from non-members and malformed payloads', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const mallory = await newUser(t);
    const id = await directChat(t, alice, bob);
    const [bs, ms] = [bob, mallory].map((d) => t.socket(d.token));
    await Promise.all([bs, ms].map((s) => connected(s)));

    const got = receivesWithin(bs, 'typing', 700);
    ms.emit('typing', { conversationId: id, state: 'start' });
    ms.emit('typing', { conversationId: id, state: 'shouting' });
    ms.emit('typing', 'nonsense');
    expect(await got).toBe(false);
  });

  it('rate-limits a flood', async () => {
    const alice = await newUser(t);
    const bob = await newUser(t);
    const id = await directChat(t, alice, bob);
    const [as, bs] = [alice, bob].map((d) => t.socket(d.token));
    await Promise.all([as, bs].map((s) => connected(s)));

    let received = 0;
    bs.on('typing', () => {
      received += 1;
    });
    for (let i = 0; i < 40; i += 1) as.emit('typing', { conversationId: id, state: i % 2 ? 'stop' : 'start' });
    await new Promise((r) => setTimeout(r, 1000));
    expect(received).toBe(20);
  });
});
