import { sha256 } from '@noble/hashes/sha2.js';
import { base32nopad, base64urlnopad, hex } from '@scure/base';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** Strict UTF-8 decode. Throws on invalid input, callers turn that into a typed error. */
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export const toBase64Url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

/** Strict base64url without padding. Throws on invalid input. */
export const fromBase64Url = (text: string): Uint8Array => base64urlnopad.decode(text);

export const toHex = (bytes: Uint8Array): string => hex.encode(bytes);

export const sha256Bytes = (bytes: Uint8Array): Uint8Array => sha256(bytes);

export const sha256Hex = (input: Uint8Array | string): string =>
  toHex(sha256(typeof input === 'string' ? utf8(input) : input));

/** Lower-case base32 (a to z, 2 to 7) without padding. */
export const toBase32Lower = (bytes: Uint8Array): string => base32nopad.encode(bytes).toLowerCase();

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Code point order comparison. Never locale dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
