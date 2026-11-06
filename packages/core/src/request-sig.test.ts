import { describe, expect, it } from 'vitest';
import { keyPairFromSeed, memberIdFromPublicKey } from './keys';
import { signRequest, verifyRequest } from './request-sig';

const kp = keyPairFromSeed(new Uint8Array(32).fill(7));
const kid = memberIdFromPublicKey(kp.publicKey);
const req = { method: 'PUT', path: '/v1/squads/sq_aaaaaaaaaaaaaaaa/charter', body: '{"a":1}' };
const nonce = new Uint8Array(16).fill(3);
const keyOf = (id: string) => (id === kid ? kp.publicKey : undefined);

describe('signed squad server requests', () => {
  const header = signRequest(req, kid, kp.secretKey, 1_800_000_000, nonce);

  it('round-trips', () => {
    const r = verifyRequest(req, header, keyOf, 1_800_000_010);
    expect(r.ok).toBe(true);
  });
  it('rejects a changed body', () => {
    const r = verifyRequest({ ...req, body: '{"a":2}' }, header, keyOf, 1_800_000_010);
    expect(r).toEqual({ ok: false, error: 'bad-signature' });
  });
  it('rejects a changed path or method', () => {
    expect(verifyRequest({ ...req, path: '/v1/x' }, header, keyOf, 1_800_000_000).ok).toBe(false);
    expect(verifyRequest({ ...req, method: 'POST' }, header, keyOf, 1_800_000_000).ok).toBe(false);
  });
  it('rejects stale timestamps', () => {
    expect(verifyRequest(req, header, keyOf, 1_800_000_200)).toEqual({ ok: false, error: 'stale' });
  });
  it('rejects unknown members and missing or malformed headers', () => {
    expect(verifyRequest(req, header, () => undefined, 1_800_000_000)).toEqual({
      ok: false,
      error: 'unknown-member',
    });
    expect(verifyRequest(req, undefined, keyOf, 1_800_000_000)).toEqual({
      ok: false,
      error: 'missing',
    });
    expect(verifyRequest(req, 'Bearer abc', keyOf, 1_800_000_000)).toEqual({
      ok: false,
      error: 'malformed',
    });
  });
});
