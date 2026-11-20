import { v7 as uuidv7 } from 'uuid';
import { createTestApp, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';
import { auth, newUser, type TestDevice } from './support/e2ee.js';

/** Feature 002, Phase 5: `GET /users` names group members who aren't contacts. */
describe('Users by id', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  const get = (who: TestDevice, ids: string[]) =>
    t.http.get('/v1/users').query(ids.map((id) => `id=${id}`).join('&')).set(auth(who.token));

  const group = (admin: TestDevice, members: TestDevice[]) =>
    t.http
      .post('/v1/conversations')
      .set(auth(admin.token))
      .send({ type: 'group', memberIds: members.map((m) => m.userId) })
      .expect(201);

  async function named(name: string) {
    const u = await newUser(t, { keys: false });
    await t.http.patch('/v1/me').set(auth(u.token)).send({ displayName: name }).expect(200);
    await t.redis.flushdb();
    return u;
  }

  it('returns self, contacts and fellow members, and leaves out strangers', async () => {
    const alice = await named('Alice');
    const bob = await named('Bob');
    const carol = await named('Carol');
    const dave = await named('Dave');
    const eve = await named('Eve');
    await group(alice, [bob]);
    await group(bob, [carol]);
    await t.http.post('/v1/contacts/discover').set(auth(alice.token)).send({ phones: [dave.phone] }).expect(200);

    const res = await get(alice, [alice.userId, bob.userId, carol.userId, dave.userId, eve.userId, uuidv7()]).expect(
      200,
    );
    expectContract('PublicUser', res.body, { array: true });
    const names = Object.fromEntries(res.body.map((u: { id: string; displayName: string }) => [u.id, u.displayName]));
    // Carol shares a group with Bob, not with Alice; Eve shares nothing.
    expect(names).toEqual({ [alice.userId]: 'Alice', [bob.userId]: 'Bob', [dave.userId]: 'Dave' });

    // A single id arrives as a string, not an array.
    const one = await get(bob, [carol.userId]).expect(200);
    expect(one.body.map((u: { id: string }) => u.id)).toEqual([carol.userId]);
  });

  it('hides former members once nothing is shared any more', async () => {
    const alice = await named('Alice');
    const bob = await named('Bob');
    const carol = await named('Carol');
    const { body } = await group(alice, [bob, carol]);
    expect((await get(bob, [carol.userId]).expect(200)).body).toHaveLength(1);

    await t.http.delete(`/v1/conversations/${body.id}/members/${carol.userId}`).set(auth(carol.token)).expect(204);
    expect((await get(bob, [carol.userId]).expect(200)).body).toEqual([]);
  });

  it('validates ids', async () => {
    const alice = await newUser(t, { keys: false });
    await t.http.get('/v1/users').set(auth(alice.token)).expect(400);
    await get(alice, ['not-a-uuid']).expect(400);
    await get(alice, Array.from({ length: 65 }, () => uuidv7())).expect(400);
    await get(alice, Array.from({ length: 64 }, () => uuidv7())).expect(200);
  });

  it('requires sign-in', async () => {
    await t.http.get('/v1/users').query(`id=${uuidv7()}`).expect(401);
  });

  it('rate limits per device', async () => {
    const alice = await newUser(t, { keys: false });
    await get(alice, [alice.userId]).expect(200);
    // Jump to the limit instead of making 120 requests.
    await t.redis.set(`rl:users:${alice.deviceId}`, '120', 'KEEPTTL');
    const res = await get(alice, [alice.userId]).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });
});
