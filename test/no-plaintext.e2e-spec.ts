import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { connected, createTestApp, nextEvent, type TestApp } from './support/app.js';
import { addWebDevice, auth, fakeCipher, newUser } from './support/e2ee.js';

/**
 * Feature 002, principle "the server never sees plaintext": run a full exchange whose
 * plaintext carries a unique marker, then scan every Postgres row and every Redis key.
 */
describe('No plaintext at rest', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.get(PrismaService);
  });
  afterAll(() => t.close());

  it('never stores the marker in Postgres or Redis', async () => {
    const marker = `PLAINTEXT-MARKER-${randomUUID()}`;
    const forms = [
      marker,
      Buffer.from(marker).toString('hex'),
      Buffer.from(marker).toString('base64'),
    ];

    const alice = await newUser(t);
    const bob = await newUser(t);
    const bobWeb = await addWebDevice(t, bob);
    const carol = await newUser(t);

    // Group with an (encrypted) name, a text message, a receipt and a typing event.
    const group = await t.http
      .post('/v1/conversations')
      .set(auth(alice.token))
      .send({ type: 'group', memberIds: [bob.userId, carol.userId] })
      .expect(201);
    const conversationId = group.body.id as string;
    const payloads = [
      { v: 1, kind: 'group_update', group: { name: `${marker} group`, memberIds: [bob.userId, carol.userId] } },
      { v: 1, kind: 'text', body: `hello ${marker}` },
    ];
    const bobSocket = t.socket(bob.token);
    await connected(bobSocket);
    for (const p of payloads) {
      const plaintext = JSON.stringify({ ...p, conversationId, messageId: randomUUID(), sentAt: Date.now() });
      await t.http
        .post('/v1/messages')
        .set(auth(alice.token))
        .send({
          conversationId,
          envelopes: [bob, bobWeb, carol].map((d) => ({
            deviceId: d.deviceId,
            type: 'prekey',
            ciphertext: fakeCipher(plaintext),
          })),
        })
        .expect(200);
    }
    const receipt = JSON.stringify({ v: 1, kind: 'receipt', receipt: { type: 'read', messageIds: [marker] } });
    await t.http
      .post('/v1/messages')
      .set(auth(bob.token))
      .send({
        conversationId,
        envelopes: [alice, bobWeb, carol].map((d) => ({
          deviceId: d.deviceId,
          type: 'whisper',
          ciphertext: fakeCipher(receipt),
        })),
      })
      .expect(200);
    const aliceSocket = t.socket(alice.token);
    await connected(aliceSocket);
    const typed = nextEvent(bobSocket, 'typing');
    aliceSocket.emit('typing', { conversationId, state: 'start' });
    await typed;

    // Postgres: every row of every table, rendered as JSON text (bytea shows as hex).
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(tables.map((r) => r.table_name)).toEqual(expect.arrayContaining(['envelopes', 'conversations']));
    expect(await prisma.envelope.count({ where: { conversationId } })).toBeGreaterThan(0);
    for (const { table_name } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${table_name}" t`,
      );
      for (const { row } of rows) {
        for (const f of forms) expect(row, `table ${table_name}`).not.toContain(f);
      }
    }

    // Redis: every key and value, whatever its type.
    let cursor = '0';
    do {
      const [next, keys] = await t.redis.scan(cursor, 'COUNT', '500');
      cursor = next;
      for (const key of keys) {
        const type = await t.redis.type(key);
        let value = '';
        if (type === 'string') value = (await t.redis.get(key)) ?? '';
        else if (type === 'hash') value = JSON.stringify(await t.redis.hgetall(key));
        else if (type === 'list') value = JSON.stringify(await t.redis.lrange(key, 0, -1));
        else if (type === 'set') value = JSON.stringify(await t.redis.smembers(key));
        else if (type === 'zset') value = JSON.stringify(await t.redis.zrange(key, '0', '-1'));
        else if (type === 'stream') value = JSON.stringify(await t.redis.xrange(key, '-', '+'));
        for (const f of forms) {
          expect(key).not.toContain(f);
          expect(value, `redis ${key}`).not.toContain(f);
        }
      }
    } while (cursor !== '0');
  });
});
