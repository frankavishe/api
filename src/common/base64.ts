import { z } from 'zod';

/** Standard (non-URL-safe) base64, as used by both Signal clients on the wire. */
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const base64 = (length?: { min?: number; max?: number; exact?: number }) => {
  let s = z.string().regex(BASE64_PATTERN, 'Must be base64');
  if (length?.exact !== undefined) s = s.length(length.exact);
  if (length?.min !== undefined) s = s.min(length.min);
  if (length?.max !== undefined) s = s.max(length.max);
  return s;
};

export function fromB64(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
