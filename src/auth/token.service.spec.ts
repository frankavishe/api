import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service.js';

const SECRET = 'test-secret-test-secret-test-secret-123';

describe('TokenService', () => {
  const jwt = new JwtService({ secret: SECRET });
  const tokens = new TokenService(jwt);
  const claims = { userId: 'u-1', deviceId: 'd-1', deviceType: 'android' as const };

  it('signs a 15-minute access token carrying user, device and device type', async () => {
    const { accessToken, expiresIn } = await tokens.signAccess(claims);
    expect(expiresIn).toBe(900);
    const payload = await jwt.verifyAsync(accessToken);
    expect(payload).toMatchObject({ sub: 'u-1', did: 'd-1', dtype: 'android' });
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('verifies its own access tokens', async () => {
    const { accessToken } = await tokens.signAccess(claims);
    await expect(tokens.verifyAccess(accessToken)).resolves.toEqual(claims);
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new JwtService({ secret: 'another-secret-another-secret-another' });
    const forged = await other.signAsync({ sub: 'u-1', did: 'd-1', dtype: 'web' }, { expiresIn: 900 });
    await expect(tokens.verifyAccess(forged)).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const expired = await jwt.signAsync({ sub: 'u-1', did: 'd-1', dtype: 'web' }, { expiresIn: -10 });
    await expect(tokens.verifyAccess(expired)).rejects.toThrow();
  });

  it('rejects tokens missing device claims', async () => {
    const partial = await jwt.signAsync({ sub: 'u-1' }, { expiresIn: 900 });
    await expect(tokens.verifyAccess(partial)).rejects.toThrow();
  });

  it('creates 256-bit url-safe refresh tokens and stores only a SHA-256 hex hash', () => {
    const a = tokens.newRefreshToken();
    const b = tokens.newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hashRefresh(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});
