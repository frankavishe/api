import { CleanupService } from '../src/auth/cleanup.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { DevicesService } from '../src/devices/devices.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, newPhone, type TestApp } from './support/app.js';

/** T030, T031, T050 — device limits and refresh-token rotation, against the real database. */
describe('DevicesService & SessionService', () => {
  let t: TestApp;
  let devices: DevicesService;
  let sessions: SessionService;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    devices = t.get(DevicesService);
    sessions = t.get(SessionService);
    prisma = t.get(PrismaService);
  });
  afterAll(() => t.close());

  describe('registerAndroid', () => {
    it('creates the account on first sign-in', async () => {
      const phone = newPhone();
      const r = await devices.registerAndroid(phone, 'Pixel 8');
      expect(r.isNewAccount).toBe(true);
      expect(r.user.phoneE164).toBe(phone);
      expect(r.device).toMatchObject({ type: 'android', name: 'Pixel 8', revokedAt: null });
    });

    it('reuses the account and revokes the previous Android device as replaced', async () => {
      const phone = newPhone();
      const first = await devices.registerAndroid(phone, 'Old phone');
      const second = await devices.registerAndroid(phone, 'New phone');
      expect(second.isNewAccount).toBe(false);
      expect(second.user.id).toBe(first.user.id);
      expect(second.revokedDeviceIds).toEqual([first.device.id]);
      const old = await prisma.device.findUniqueOrThrow({ where: { id: first.device.id } });
      expect(old.revokedReason).toBe('replaced');
    });

    it('does not touch web devices', async () => {
      const phone = newPhone();
      await devices.registerAndroid(phone, 'Phone');
      const web = await devices.registerWeb(phone, 'Chrome');
      await devices.registerAndroid(phone, 'Phone 2');
      const w = await prisma.device.findUniqueOrThrow({ where: { id: web.device.id } });
      expect(w.revokedAt).toBeNull();
    });

    it('keeps exactly one active Android device under concurrent sign-ins', async () => {
      const phone = newPhone();
      await devices.registerAndroid(phone, 'Seed');
      await Promise.all([1, 2, 3, 4].map((i) => devices.registerAndroid(phone, `Phone ${i}`)));
      const user = await prisma.user.findUniqueOrThrow({ where: { phoneE164: phone } });
      const active = await prisma.device.count({
        where: { userId: user.id, type: 'android', revokedAt: null },
      });
      expect(active).toBe(1);
    });
  });

  describe('registerWeb', () => {
    it('refuses numbers without an account (ACCOUNT_NOT_FOUND)', async () => {
      await expect(devices.registerWeb(newPhone(), 'Chrome')).rejects.toMatchObject({
        status: 404,
        response: { code: 'ACCOUNT_NOT_FOUND' },
      });
    });

    it('evicts the least recently active web device when a 5th signs in', async () => {
      const phone = newPhone();
      await devices.registerAndroid(phone, 'Phone');
      const webs = [];
      for (let i = 0; i < 4; i++) webs.push(await devices.registerWeb(phone, `Browser ${i}`));
      // Browser 2 is the least recently active.
      for (const [i, w] of webs.entries()) {
        await prisma.device.update({
          where: { id: w.device.id },
          data: { lastActiveAt: new Date(Date.now() - (i === 2 ? 10_000 : 1_000)) },
        });
      }
      const fifth = await devices.registerWeb(phone, 'Browser 4');
      expect(fifth.revokedDeviceIds).toEqual([webs[2].device.id]);
      const evicted = await prisma.device.findUniqueOrThrow({ where: { id: webs[2].device.id } });
      expect(evicted.revokedReason).toBe('evicted');
      const active = await prisma.device.count({
        where: { userId: fifth.user.id, type: 'web', revokedAt: null },
      });
      expect(active).toBe(4);
    });
  });

  describe('SessionService', () => {
    async function newDevice() {
      const r = await devices.registerAndroid(newPhone(), 'Phone');
      return r.device;
    }

    it('rotates a refresh token and returns a different one', async () => {
      const device = await newDevice();
      const { refreshToken } = await sessions.create(device.id);
      const rotated = await sessions.rotate(refreshToken);
      expect(rotated.device.id).toBe(device.id);
      expect(rotated.refreshToken).not.toBe(refreshToken);
      await expect(sessions.rotate(rotated.refreshToken)).resolves.toBeDefined();
    });

    it('detects reuse of a rotated token and revokes the device (token_reuse)', async () => {
      const device = await newDevice();
      const { refreshToken } = await sessions.create(device.id);
      const rotated = await sessions.rotate(refreshToken);
      await expect(sessions.rotate(refreshToken)).rejects.toMatchObject({
        status: 401,
        response: { code: 'SESSION_REVOKED' },
      });
      const d = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
      expect(d.revokedReason).toBe('token_reuse');
      // The thief's and the owner's newer token are both dead now.
      await expect(sessions.rotate(rotated.refreshToken)).rejects.toMatchObject({ status: 401 });
    });

    it('revokes the device as inactive when the refresh token has expired', async () => {
      const device = await newDevice();
      const { refreshToken } = await sessions.create(device.id);
      await prisma.session.updateMany({
        where: { deviceId: device.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(sessions.rotate(refreshToken)).rejects.toMatchObject({ status: 401 });
      const d = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
      expect(d.revokedReason).toBe('inactive');
    });

    it('rejects unknown tokens and tokens of revoked devices', async () => {
      await expect(sessions.rotate('not-a-real-token')).rejects.toMatchObject({ status: 401 });
      const device = await newDevice();
      const { refreshToken } = await sessions.create(device.id);
      await devices.revoke(device.id, 'signed_out');
      await expect(sessions.rotate(refreshToken)).rejects.toMatchObject({
        response: { code: 'SESSION_REVOKED' },
      });
    });
  });
});


/** T067 — housekeeping job. */
describe('CleanupService', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('deletes codes older than a day and signs out devices idle for 30 days', async () => {
    const prisma = t.get(PrismaService);
    const devices = t.get(DevicesService);
    const phone = newPhone();
    const idle = await devices.registerAndroid(phone, 'Old phone');
    const fresh = await devices.registerWeb(phone, 'Chrome');
    await prisma.device.update({
      where: { id: idle.device.id },
      data: { lastActiveAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) },
    });
    await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
    await prisma.otpChallenge.updateMany({
      where: { phoneE164: phone },
      data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });

    await t.get(CleanupService).run();

    expect(await prisma.otpChallenge.count({ where: { phoneE164: phone } })).toBe(0);
    const [i, f] = await Promise.all([
      prisma.device.findUniqueOrThrow({ where: { id: idle.device.id } }),
      prisma.device.findUniqueOrThrow({ where: { id: fresh.device.id } }),
    ]);
    expect(i.revokedReason).toBe('inactive');
    expect(f.revokedAt).toBeNull();
  });
});
