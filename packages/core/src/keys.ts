import { ed25519 } from '@noble/curves/ed25519.js';
import { concatBytes, sha256Bytes, toBase32Lower } from './bytes';

// core never generates randomness. The caller supplies a 32-byte seed from a CSPRNG (agent) or a
// fixed value (tests, fixtures).

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is exactly 32 bytes.');
  return { secretKey: seed, publicKey: ed25519.getPublicKey(seed) };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

/** False for a wrong signature and for malformed key or signature bytes. Never throws. */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** `m_` plus the first 16 characters of base32(sha256(public key)). */
export function memberIdFromPublicKey(publicKey: Uint8Array): string {
  return `m_${toBase32Lower(sha256Bytes(publicKey)).slice(0, 16)}`;
}

/** `sq_` plus the first 16 characters of base32(sha256(leader public key, 16-byte nonce)). */
export function squadIdFrom(leaderPublicKey: Uint8Array, nonce: Uint8Array): string {
  if (nonce.length !== 16) throw new Error('A squad nonce is exactly 16 bytes.');
  return `sq_${toBase32Lower(sha256Bytes(concatBytes(leaderPublicKey, nonce))).slice(0, 16)}`;
}
