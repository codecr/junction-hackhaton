import { describe, expect, it } from 'vitest';
import { testCharter, testManifest, testMember } from '../test/helpers';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './bytes';
import { canonicalBytes } from './canonical';
import { isNewer, openCharter, openMessage, signMessage } from './envelope';
import { sign } from './keys';
import type { Envelope } from './schemas';

const ana = testMember('Ana', 1); // leader
const luis = testMember('Luis', 2);
const eve = testMember('Eve', 3); // never joins
const charter = testCharter([ana, luis]);

const signedCharter = () => signMessage(charter, ana.memberId, ana.keys.secretKey);
const luisManifest = () => testManifest(luis, charter);
const signedManifest = () => signMessage(luisManifest(), luis.memberId, luis.keys.secretKey);

/** Replaces the payload with different bytes but keeps the original signature. */
function withPayload(envelope: Envelope, payload: Uint8Array): Envelope {
  return { ...envelope, payload: toBase64Url(payload) };
}

const code = <T extends { ok: boolean }>(r: T) =>
  r.ok ? 'ok' : (r as unknown as { error: { code: string } }).error.code;

describe('round trip', () => {
  it('opens a signed manifest', () => {
    const result = openMessage(signedManifest(), charter);
    expect(result.ok && result.value).toEqual(luisManifest());
  });

  it('opens a signed charter', () => {
    const result = openCharter(signedCharter());
    expect(result.ok && result.value).toEqual(charter);
  });

  it('survives JSON serialisation, as it would on the wire or in a file', () => {
    const wire = JSON.parse(JSON.stringify(signedManifest()));
    expect(openMessage(wire, charter).ok).toBe(true);
  });

  it('produces the same envelope for the same input (deterministic)', () => {
    expect(signedManifest()).toEqual(signedManifest());
  });

  it('refuses to sign an invalid message', () => {
    const bad = { ...luisManifest(), share: 'L0', busy: [] } as never;
    expect(() => signMessage(bad, luis.memberId, luis.keys.secretKey)).toThrow();
  });
});

describe('tampering', () => {
  it('rejects a changed payload', () => {
    const env = signedManifest();
    const edited = { ...luisManifest(), seq: 99 };
    const forged = withPayload(env, utf8(JSON.stringify(edited)));
    expect(code(openMessage(forged, charter))).toBe('bad-signature');
  });

  it('rejects a single flipped bit in the payload', () => {
    const env = signedManifest();
    const bytes = fromBase64Url(env.payload);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    expect(code(openMessage(withPayload(env, bytes), charter))).toBe('bad-signature');
  });

  it('rejects a changed signature', () => {
    const env = signedManifest();
    const sig = fromBase64Url(env.sig);
    sig[5] = (sig[5] ?? 0) ^ 1;
    expect(code(openMessage({ ...env, sig: toBase64Url(sig) }, charter))).toBe('bad-signature');
  });

  it('rejects a signature taken from another message', () => {
    const other = signMessage({ ...luisManifest(), seq: 2 }, luis.memberId, luis.keys.secretKey);
    expect(code(openMessage({ ...signedManifest(), sig: other.sig }, charter))).toBe(
      'bad-signature',
    );
  });

  it('rejects a changed kid that names another member', () => {
    const env = { ...signedManifest(), kid: ana.memberId };
    expect(code(openMessage(env, charter))).toBe('bad-signature');
  });

  it('rejects a signer who is not in the charter', () => {
    const outsider = signMessage(testManifest(eve, charter), eve.memberId, eve.keys.secretKey);
    const result = openMessage(outsider, charter);
    expect(code(result)).toBe('unknown-signer');
    expect(!result.ok && result.error.message).toMatch(/Ask the leader/);
  });

  it('rejects reordered fields: the bytes change, so the signature no longer holds', () => {
    const env = signedManifest();
    const parsed = JSON.parse(fromUtf8(fromBase64Url(env.payload))) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    expect(code(openMessage(withPayload(env, utf8(JSON.stringify(reordered))), charter))).toBe(
      'bad-signature',
    );
  });

  it('rejects a validly signed payload that is not canonical', () => {
    const nonCanonical = utf8(
      JSON.stringify(Object.fromEntries(Object.entries(luisManifest()).reverse())),
    );
    const env: Envelope = {
      kid: luis.memberId,
      alg: 'Ed25519',
      payload: toBase64Url(nonCanonical),
      sig: toBase64Url(sign(nonCanonical, luis.keys.secretKey)),
    };
    expect(code(openMessage(env, charter))).toBe('non-canonical');
  });

  it('rejects a member who signs a message in another member name', () => {
    const lie = signMessage(testManifest(ana, charter), luis.memberId, luis.keys.secretKey);
    expect(code(openMessage(lie, charter))).toBe('signer-mismatch');
  });

  it('rejects a signed payload that fails validation (a title smuggled in)', () => {
    const smuggled = {
      ...luisManifest(),
      sessions: [{ sessionId: 's-1', code: 'AGT301', status: 'reserved', title: 'x' }],
    };
    const bytes = canonicalBytes(smuggled);
    const env: Envelope = {
      kid: luis.memberId,
      alg: 'Ed25519',
      payload: toBase64Url(bytes),
      sig: toBase64Url(sign(bytes, luis.keys.secretKey)),
    };
    const result = openMessage(env, charter);
    expect(code(result)).toBe('invalid-payload');
    expect(!result.ok && result.error.message).toMatch(/title/);
  });
});

describe('malformed input', () => {
  it.each([null, undefined, 42, 'text', [], {}, { kid: 'x' }])('rejects %j', (raw) => {
    expect(code(openMessage(raw, charter))).toBe('malformed');
    expect(code(openCharter(raw))).toBe('malformed');
  });

  it('rejects a payload that is not JSON', () => {
    const bytes = utf8('not json');
    const env: Envelope = {
      kid: luis.memberId,
      alg: 'Ed25519',
      payload: toBase64Url(bytes),
      sig: toBase64Url(sign(bytes, luis.keys.secretKey)),
    };
    expect(code(openMessage(env, charter))).toBe('malformed');
  });

  it('rejects an oversized payload', () => {
    const env = { ...signedManifest(), payload: 'A'.repeat(87_401) };
    expect(code(openMessage(env, charter))).toBe('malformed');
  });
});

describe('squad and event binding', () => {
  it('rejects a message for another squad', () => {
    const other = testCharter([ana, luis], { squadId: 'sq_aaaaaaaaaaaaaaaa' });
    const env = signMessage(testManifest(luis, other), luis.memberId, luis.keys.secretKey);
    expect(code(openMessage(env, charter))).toBe('wrong-squad');
  });

  it('rejects a manifest for another event', () => {
    const env = signMessage(
      testManifest(luis, charter, { eventId: 'summit2027' }),
      luis.memberId,
      luis.keys.secretKey,
    );
    expect(code(openMessage(env, charter))).toBe('wrong-event');
  });

  it('does not open a charter as a member message', () => {
    expect(code(openMessage(signedCharter(), charter))).toBe('invalid-payload');
  });
});

describe('charter authority', () => {
  it('rejects a charter signed by a member who is not the leader', () => {
    const forged = signMessage(charter, luis.memberId, luis.keys.secretKey);
    expect(code(openCharter(forged))).toBe('signer-mismatch');
  });

  it('rejects a charter whose signature does not match the leader key', () => {
    const forged = signMessage(charter, ana.memberId, eve.keys.secretKey);
    expect(code(openCharter(forged))).toBe('bad-signature');
  });

  it('rejects a charter whose member id does not match its public key', () => {
    const lying = testCharter([ana, luis]);
    lying.members[1] = { ...lying.members[1]!, memberId: eve.memberId };
    const env = signMessage(lying, ana.memberId, ana.keys.secretKey);
    expect(code(openCharter(env))).toBe('invalid-payload');
  });

  it('rejects two leaders, or a leader that is not charter.leader', () => {
    const two = testCharter([ana, luis]);
    two.members[1] = { ...two.members[1]!, role: 'leader' };
    expect(code(openCharter(signMessage(two, ana.memberId, ana.keys.secretKey)))).toBe(
      'invalid-payload',
    );
  });

  it('rejects a charter that expires before it is issued', () => {
    const bad = testCharter([ana, luis], { expiresAt: '2026-10-01T00:00:00Z' });
    expect(code(openCharter(signMessage(bad, ana.memberId, ana.keys.secretKey)))).toBe(
      'invalid-payload',
    );
  });

  it('accepts a newer charter and rejects an old or equal one', () => {
    const next = testCharter([ana, luis], { seq: 2 });
    const nextEnv = signMessage(next, ana.memberId, ana.keys.secretKey);
    expect(openCharter(nextEnv, charter).ok).toBe(true);
    expect(code(openCharter(signedCharter(), charter))).toBe('stale');
    expect(code(openCharter(signedCharter(), next))).toBe('stale');
  });

  it('rejects a charter from another squad or with a new leader', () => {
    const otherSquad = testCharter([ana, luis], { seq: 5, squadId: 'sq_bbbbbbbbbbbbbbbb' });
    expect(
      code(openCharter(signMessage(otherSquad, ana.memberId, ana.keys.secretKey), charter)),
    ).toBe('wrong-squad');
    const newLeader = testCharter([luis, ana], { seq: 5, squadId: charter.squadId });
    expect(
      code(openCharter(signMessage(newLeader, luis.memberId, luis.keys.secretKey), charter)),
    ).toBe('signer-mismatch');
  });

  it('uses a key set the new charter carries, so a removed member stops verifying', () => {
    const without = testCharter([ana], { seq: 2 });
    expect(openCharter(signMessage(without, ana.memberId, ana.keys.secretKey), charter).ok).toBe(
      true,
    );
    expect(code(openMessage(signedManifest(), without))).toBe('unknown-signer');
  });
});

describe('isNewer', () => {
  it('accepts the first message and any strictly higher seq', () => {
    expect(isNewer(0, undefined)).toBe(true);
    expect(isNewer(3, 2)).toBe(true);
  });
  it('rejects a replay of the same or an older seq', () => {
    expect(isNewer(2, 2)).toBe(false);
    expect(isNewer(1, 2)).toBe(false);
  });
});
