import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Returns the number in E.164 format if it is a valid phone number, otherwise null.
 * National-format input needs `defaultCountry`.
 */
export function normalizePhone(input: string, defaultCountry?: CountryCode): string | null {
  if (!input || input.length > 32) return null;
  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
