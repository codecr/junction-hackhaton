import { canonicalize } from 'json-canonicalize';
import { utf8 } from './bytes';

/** RFC 8785 (JCS) canonical JSON text. */
export function canonicalJson(value: unknown): string {
  const text = canonicalize(value);
  if (typeof text !== 'string') throw new Error('Value has no JSON representation.');
  return text;
}

/** UTF-8 bytes of the canonical JSON. This is what signatures and hashes cover. */
export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}
