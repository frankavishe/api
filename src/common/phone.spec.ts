import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('accepts a valid E.164 number unchanged', () => {
    expect(normalizePhone('+255712345678')).toBe('+255712345678');
  });

  it('strips spaces and punctuation from an international number', () => {
    expect(normalizePhone('+255 712-345 678')).toBe('+255712345678');
  });

  it('converts a national number using the default country', () => {
    expect(normalizePhone('0712 345 678', 'TZ')).toBe('+255712345678');
  });

  it('rejects a national number when no country is given', () => {
    expect(normalizePhone('0712345678')).toBeNull();
  });

  it('rejects numbers that are not valid for their country', () => {
    expect(normalizePhone('+2551')).toBeNull();
    expect(normalizePhone('+1 555 0100')).toBeNull();
  });

  it('rejects junk', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('+'.padEnd(40, '9'))).toBeNull();
  });
});
