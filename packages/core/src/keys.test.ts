import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, toHex, utf8 } from './bytes';
import { keyPairFromSeed, memberIdFromPublicKey, sign, squadIdFrom, verify } from './keys';
import { MEMBER_ID_PATTERN, SQUAD_ID_PATTERN } from './schemas';

const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe('Ed25519 (RFC 8032 test vectors)', () => {
  it('vector 1: empty message', () => {
    const { publicKey, secretKey } = keyPairFromSeed(
      fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
    );
    expect(toHex(publicKey)).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    const sig = sign(new Uint8Array(0), secretKey);
    expect(toHex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(verify(sig, new Uint8Array(0), publicKey)).toBe(true);
  });

  it('vector 2: one byte', () => {
    const { publicKey, secretKey } = keyPairFromSeed(
      fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'),
    );
    expect(toHex(publicKey)).toBe(
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    );
    const sig = sign(fromHex('72'), secretKey);
    expect(toHex(sig)).toBe(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    );
  });
});

describe('verify', () => {
  const alice = keyPairFromSeed(new Uint8Array(32).fill(1));
  const bob = keyPairFromSeed(new Uint8Array(32).fill(2));
  const message = utf8('hello squad');
  const signature = sign(message, alice.secretKey);

  it('accepts a good signature', () => {
    expect(verify(signature, message, alice.publicKey)).toBe(true);
  });

  it('is deterministic', () => {
    expect(toHex(sign(message, alice.secretKey))).toBe(toHex(signature));
  });

  it('rejects another message, another key, and a flipped bit', () => {
    expect(verify(signature, utf8('hello squad!'), alice.publicKey)).toBe(false);
    expect(verify(signature, message, bob.publicKey)).toBe(false);
    const flipped = Uint8Array.from(signature);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(verify(flipped, message, alice.publicKey)).toBe(false);
  });

  it('returns false, not an exception, for malformed input', () => {
    expect(verify(new Uint8Array(3), message, alice.publicKey)).toBe(false);
    expect(verify(signature, message, new Uint8Array(5))).toBe(false);
  });

  it('requires a 32-byte seed', () => {
    expect(() => keyPairFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('identifiers', () => {
  const key = keyPairFromSeed(new Uint8Array(32).fill(1)).publicKey;

  it('builds a member id that matches the schema pattern', () => {
    const id = memberIdFromPublicKey(key);
    expect(id).toMatch(MEMBER_ID_PATTERN);
    expect(memberIdFromPublicKey(key)).toBe(id);
  });

  it('gives different members different ids', () => {
    const other = keyPairFromSeed(new Uint8Array(32).fill(2)).publicKey;
    expect(memberIdFromPublicKey(other)).not.toBe(memberIdFromPublicKey(key));
  });

  it('builds a squad id from the leader key and a 16-byte nonce', () => {
    const a = squadIdFrom(key, new Uint8Array(16).fill(1));
    expect(a).toMatch(SQUAD_ID_PATTERN);
    expect(squadIdFrom(key, new Uint8Array(16).fill(2))).not.toBe(a);
    expect(() => squadIdFrom(key, new Uint8Array(8))).toThrow(/16 bytes/);
  });

  it('round-trips base64url', () => {
    const bytes = Uint8Array.from([251, 255, 254, 0, 1]);
    expect(toBase64Url(bytes)).toBe('-__-AAE');
    expect(Array.from(fromBase64Url('-__-AAE'))).toEqual(Array.from(bytes));
  });
});
