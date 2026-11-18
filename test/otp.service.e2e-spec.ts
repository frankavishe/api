import { createHmac } from 'node:crypto';
import { OtpService } from '../src/auth/otp.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, newPhone, type TestApp } from './support/app.js';

/** T029 — OTP rules (FR-001, FR-002), against the real database. */
describe('OtpService', () => {
  let t: TestApp;
  let otp: OtpService;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    otp = t.get(OtpService);
    prisma = t.get(PrismaService);
  });
  afterAll(() => t.close());

  it('sends a 6-digit code and reports expiry/resend timings', async () => {
    const phone = newPhone();
    await expect(otp.request(phone)).resolves.toEqual({ expiresIn: 300, resendAfter: 60 });
    expect(t.sms.lastCode(phone)).toMatch(/^\d{6}$/);
  });

  it('stores only an HMAC of the code, never the code', async () => {
    const phone = newPhone();
    await otp.request(phone);
    const code = t.sms.lastCode(phone);
    const row = await prisma.otpChallenge.findFirstOrThrow({ where: { phoneE164: phone } });
    expect(row.codeHmac).not.toContain(code);
    const expected = createHmac('sha256', process.env.OTP_PEPPER!).update(`${phone}:${code}`).digest('hex');
    expect(row.codeHmac).toBe(expected);
  });

  it('accepts the correct code once', async () => {
    const phone = newPhone();
    await otp.request(phone);
    const code = t.sms.lastCode(phone);
    await expect(otp.verify(phone, code)).resolves.toBeUndefined();
    await expect(otp.verify(phone, code)).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
  });

  it('rejects a wrong code with INVALID_CODE', async () => {
    const phone = newPhone();
    await otp.request(phone);
    const wrong = t.sms.lastCode(phone) === '000000' ? '111111' : '000000';
    await expect(otp.verify(phone, wrong)).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_CODE' },
    });
  });

  it('invalidates the code after 5 wrong attempts, even for the right code afterwards', async () => {
    const phone = newPhone();
    await otp.request(phone);
    const code = t.sms.lastCode(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await expect(otp.verify(phone, wrong)).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
    }
    await expect(otp.verify(phone, wrong)).rejects.toMatchObject({ response: { code: 'TOO_MANY_ATTEMPTS' } });
    await expect(otp.verify(phone, code)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired code with CODE_EXPIRED', async () => {
    const phone = newPhone();
    await otp.request(phone);
    await prisma.otpChallenge.updateMany({
      where: { phoneE164: phone },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(otp.verify(phone, t.sms.lastCode(phone))).rejects.toMatchObject({
      response: { code: 'CODE_EXPIRED' },
    });
  });

  it('a newer code invalidates the older one', async () => {
    const phone = newPhone();
    await otp.request(phone);
    const first = t.sms.lastCode(phone);
    await t.redis.flushdb(); // skip the 60 s resend limit
    await otp.request(phone);
    const second = t.sms.lastCode(phone);
    if (first !== second) {
      await expect(otp.verify(phone, first)).rejects.toMatchObject({ status: 401 });
    }
    await expect(otp.verify(phone, second)).resolves.toBeUndefined();
  });

  it('rejects verification when no code was requested', async () => {
    await expect(otp.verify(newPhone(), '123456')).rejects.toMatchObject({
      response: { code: 'INVALID_CODE' },
    });
  });
});
