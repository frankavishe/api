import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { connected, createTestApp, newPhone, nextEvent, type TestApp } from './support/app.js';
import { expectContract, expectEvent } from './support/contract.js';
import { auth, newUser, receivesWithin, type TestDevice } from './support/e2ee.js';

/** Feature 002 — conversations and group membership. */
describe('Conversations', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.get(PrismaService);
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  /** Users that exist but never sign in; enough to fill a group quickly. */
  async function bulkUsers(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => uuidv7());
    await prisma.user.createMany({ data: ids.map((id) => ({ id, phoneE164: newPhone() })) });
    return ids;
  }

  const create = (who: TestDevice, body: object) =>
    t.http.post('/v1/conversations').set(auth(who.token)).send(body);

  describe('direct', () => {
    it('is idempotent from either side and notifies the peer once', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const bobSocket = t.socket(bob.token);
      await connected(bobSocket);
      const updated = nextEvent(bobSocket, 'conversation:updated');

      const first = await create(alice, { type: 'direct', peerId: bob.userId }).expect(201);
      expectContract('Conversation', first.body);
      expect(first.body.type).toBe('direct');
      expect(first.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual(
        [alice.userId, bob.userId].sort(),
      );
      const event = await updated;
      expectEvent('conversation:updated', event);
      expect(event).toEqual(first.body);

      const again = await create(alice, { type: 'direct', peerId: bob.userId }).expect(200);
      const fromBob = await create(bob, { type: 'direct', peerId: alice.userId }).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(fromBob.body.id).toBe(first.body.id);
    });

    it('converges when both sides create at the same time', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const [a, b] = await Promise.all([
        create(alice, { type: 'direct', peerId: bob.userId }),
        create(bob, { type: 'direct', peerId: alice.userId }),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
    });

    it('rejects yourself and unknown users', async () => {
      const alice = await newUser(t);
      await create(alice, { type: 'direct', peerId: alice.userId }).expect(400);
      const res = await create(alice, { type: 'direct', peerId: uuidv7() }).expect(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('cannot add or remove members of a direct chat', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const [carol] = await bulkUsers(1);
      const { body } = await create(alice, { type: 'direct', peerId: bob.userId }).expect(201);
      await t.http
        .post(`/v1/conversations/${body.id}/members`)
        .set(auth(alice.token))
        .send({ userIds: [carol] })
        .expect(400);
      await t.http.delete(`/v1/conversations/${body.id}/members/${bob.userId}`).set(auth(alice.token)).expect(400);
    });
  });

  describe('groups', () => {
    it('creates a group with the caller as admin and notifies members', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const [carol] = await bulkUsers(1);
      const bobSocket = t.socket(bob.token);
      await connected(bobSocket);
      const updated = nextEvent(bobSocket, 'conversation:updated');

      const res = await create(alice, { type: 'group', memberIds: [bob.userId, carol] }).expect(201);
      expectContract('Conversation', res.body);
      const roles = Object.fromEntries(res.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]));
      expect(roles).toEqual({ [alice.userId]: 'admin', [bob.userId]: 'member', [carol]: 'member' });
      expect(await updated).toEqual(res.body);

      const list = await t.http.get('/v1/conversations').set(auth(bob.token)).expect(200);
      expectContract('Conversation', list.body, { array: true });
      expect(list.body.map((c: { id: string }) => c.id)).toContain(res.body.id);
    });

    it('validates member lists', async () => {
      const alice = await newUser(t);
      const [bob] = await bulkUsers(1);
      await create(alice, { type: 'group', memberIds: [] }).expect(400);
      await create(alice, { type: 'group', memberIds: [bob, bob] }).expect(400);
      await create(alice, { type: 'group', memberIds: [alice.userId] }).expect(400);
      await create(alice, { type: 'group', memberIds: await bulkUsers(64) }).expect(400);
      const res = await create(alice, { type: 'group', memberIds: [uuidv7()] }).expect(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('caps groups at 64 members', async () => {
      const alice = await newUser(t);
      const others = await bulkUsers(63);
      const { body } = await create(alice, { type: 'group', memberIds: others }).expect(201);
      expect(body.members).toHaveLength(64);
      const [extra] = await bulkUsers(1);
      const res = await t.http
        .post(`/v1/conversations/${body.id}/members`)
        .set(auth(alice.token))
        .send({ userIds: [extra] })
        .expect(400);
      expectContract('Error', res.body);
      expect(res.body.code).toBe('GROUP_TOO_LARGE');
    });

    it('hides conversations from non-members', async () => {
      const alice = await newUser(t);
      const mallory = await newUser(t);
      const [bob] = await bulkUsers(1);
      const { body } = await create(alice, { type: 'group', memberIds: [bob] }).expect(201);
      const res = await t.http.get(`/v1/conversations/${body.id}`).set(auth(mallory.token)).expect(404);
      expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
      await t.http
        .post(`/v1/conversations/${body.id}/members`)
        .set(auth(mallory.token))
        .send({ userIds: [mallory.userId] })
        .expect(404);
      await t.http.delete(`/v1/conversations/${body.id}/members/${bob}`).set(auth(mallory.token)).expect(404);
      const list = await t.http.get('/v1/conversations').set(auth(mallory.token)).expect(200);
      expect(list.body).toEqual([]);
      await t.http.get(`/v1/conversations/${body.id}`).set(auth(alice.token)).expect(200);
    });

    it('only admins add members; everyone gets conversation:updated', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const [carol, dave] = await bulkUsers(2);
      const { body } = await create(alice, { type: 'group', memberIds: [bob.userId] }).expect(201);

      const denied = await t.http
        .post(`/v1/conversations/${body.id}/members`)
        .set(auth(bob.token))
        .send({ userIds: [carol] })
        .expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');

      const bobSocket = t.socket(bob.token);
      await connected(bobSocket);
      const updated = nextEvent(bobSocket, 'conversation:updated');
      const res = await t.http
        .post(`/v1/conversations/${body.id}/members`)
        .set(auth(alice.token))
        .send({ userIds: [carol, dave, bob.userId] })
        .expect(200);
      expectContract('Conversation', res.body);
      expect(res.body.members).toHaveLength(4);
      expect(await updated).toEqual(res.body);
    });

    it('admins remove members, members leave, and the oldest member is promoted', async () => {
      const alice = await newUser(t);
      const bob = await newUser(t);
      const carol = await newUser(t);
      const { body } = await create(alice, { type: 'group', memberIds: [bob.userId, carol.userId] }).expect(201);
      const path = (userId: string) => `/v1/conversations/${body.id}/members/${userId}`;

      // A member cannot remove someone else.
      const denied = await t.http.delete(path(carol.userId)).set(auth(bob.token)).expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');

      // Admin removes carol: she gets removed:true, bob gets the new member list.
      const carolSocket = t.socket(carol.token);
      const bobSocket = t.socket(bob.token);
      await Promise.all([connected(carolSocket), connected(bobSocket)]);
      const removed = nextEvent(carolSocket, 'conversation:updated');
      const bobUpdate = nextEvent<{ members: { userId: string }[] }>(bobSocket, 'conversation:updated');
      await t.http.delete(path(carol.userId)).set(auth(alice.token)).expect(204);
      const removedPayload = await removed;
      expectEvent('conversation:updated', removedPayload);
      expect(removedPayload).toEqual({ id: body.id, removed: true });
      expect((await bobUpdate).members.map((m) => m.userId).sort()).toEqual([alice.userId, bob.userId].sort());
      await t.http.get(`/v1/conversations/${body.id}`).set(auth(carol.token)).expect(404);

      const gone = await t.http.delete(path(carol.userId)).set(auth(alice.token)).expect(404);
      expect(gone.body.code).toBe('NOT_A_MEMBER');

      // The only admin leaves: bob is promoted.
      await t.http.delete(path(alice.userId)).set(auth(alice.token)).expect(204);
      const res = await t.http.get(`/v1/conversations/${body.id}`).set(auth(bob.token)).expect(200);
      expect(res.body.members).toEqual([expect.objectContaining({ userId: bob.userId, role: 'admin' })]);

      // Last member leaves: the group is deleted.
      await t.http.delete(path(bob.userId)).set(auth(bob.token)).expect(204);
      expect(await prisma.conversation.count({ where: { id: body.id } })).toBe(0);
    });

    it('does not notify users outside the conversation', async () => {
      const alice = await newUser(t);
      const outsider = await newUser(t);
      const [bob] = await bulkUsers(1);
      const s = t.socket(outsider.token);
      await connected(s);
      const got = receivesWithin(s, 'conversation:updated');
      await create(alice, { type: 'group', memberIds: [bob] }).expect(201);
      expect(await got).toBe(false);
    });
  });
});
