import { PrismaService } from '../src/prisma/prisma.service.js';
import { connected, createTestApp, newPhone, nextEvent, signIn, type TestApp } from './support/app.js';
import { expectContract } from './support/contract.js';

/** T062 — contact discovery and lookup (US5, FR-013..FR-015). */
describe('Contacts', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.get(PrismaService);
  });
  beforeEach(() => t.redis.flushdb());
  afterAll(() => t.close());

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function user(name: string) {
    const phone = newPhone();
    const { body } = await signIn(t, phone);
    await t.http.patch('/v1/me').set(auth(body.accessToken)).send({ displayName: name }).expect(200);
    await t.redis.flushdb();
    return { phone, token: body.accessToken as string, id: body.user.id as string };
  }

  it('returns only registered numbers, excludes self, and stores only matches', async () => {
    const me = await user('Me');
    const bob = await user('Bob');
    const unregistered = [newPhone(), newPhone()];

    const res = await t.http
      .post('/v1/contacts/discover')
      .set(auth(me.token))
      .send({ phones: [bob.phone, me.phone, ...unregistered] })
      .expect(200);
    expectContract('PublicUser', res.body, { array: true });
    expect(res.body).toEqual([expect.objectContaining({ id: bob.id, phone: bob.phone, displayName: 'Bob' })]);

    const stored = await prisma.contact.findMany({ where: { ownerId: me.id } });
    expect(stored.map((c) => c.contactUserId)).toEqual([bob.id]);
    const anyUnregistered = await prisma.user.count({ where: { phoneE164: { in: unregistered } } });
    expect(anyUnregistered).toBe(0);
  });

  it('GET /contacts lists discovered contacts sorted by name', async () => {
    const me = await user('Me');
    const zed = await user('Zed');
    const amy = await user('Amy');
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [zed.phone, amy.phone] }).expect(200);
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [amy.phone] }).expect(200);

    const res = await t.http.get('/v1/contacts').set(auth(me.token)).expect(200);
    expectContract('PublicUser', res.body, { array: true });
    expect(res.body.map((u: { displayName: string }) => u.displayName)).toEqual(['Amy', 'Zed']);
  });

  it('validates the list: E.164 only, 1..1000 numbers', async () => {
    const me = await user('Me');
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [] }).expect(400);
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: ['0712345678'] }).expect(400);
    const tooMany = Array.from({ length: 1001 }, () => newPhone());
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: tooMany }).expect(400);
  });

  it('handles 1,000 numbers in under 3 seconds (SC-004)', async () => {
    const me = await user('Me');
    const phones = Array.from({ length: 1000 }, () => newPhone());
    const started = Date.now();
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones }).expect(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('rate limits discovery per device', async () => {
    const me = await user('Me');
    for (let i = 0; i < 10; i++) {
      await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [newPhone()] }).expect(200);
    }
    const res = await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [newPhone()] }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('looks up a single number', async () => {
    const me = await user('Me');
    const bob = await user('Bob');
    const found = await t.http.get('/v1/users/lookup').query({ phone: bob.phone }).set(auth(me.token)).expect(200);
    expectContract('PublicUser', found.body);
    expect(found.body).toMatchObject({ id: bob.id, displayName: 'Bob' });

    const missing = await t.http.get('/v1/users/lookup').query({ phone: newPhone() }).set(auth(me.token)).expect(404);
    expectContract('Error', missing.body);
    expect(missing.body.code).toBe('USER_NOT_FOUND');

    await t.http.get('/v1/users/lookup').query({ phone: 'abc' }).set(auth(me.token)).expect(400);
  });

  it('contacts receive profile:updated when someone they have changes their profile', async () => {
    const me = await user('Me');
    const bob = await user('Bob');
    await t.http.post('/v1/contacts/discover').set(auth(me.token)).send({ phones: [bob.phone] }).expect(200);
    const socket = t.socket(me.token);
    await connected(socket);
    const update = nextEvent<{ id: string; about: string }>(socket, 'profile:updated');
    await t.http.patch('/v1/me').set(auth(bob.token)).send({ about: 'At the gym' }).expect(200);
    await expect(update).resolves.toMatchObject({ id: bob.id, about: 'At the gym' });
  });
});
