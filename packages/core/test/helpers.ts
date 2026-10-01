import { toBase64Url } from '../src/bytes';
import { keyPairFromSeed, memberIdFromPublicKey, squadIdFrom, type KeyPair } from '../src/keys';
import type { Charter, Manifest } from '../src/schemas';

export interface TestMember {
  name: string;
  keys: KeyPair;
  memberId: string;
}

/** Deterministic member: the seed is the byte `n` repeated 32 times. */
export function testMember(name: string, n: number): TestMember {
  const keys = keyPairFromSeed(new Uint8Array(32).fill(n));
  return { name, keys, memberId: memberIdFromPublicKey(keys.publicKey) };
}

export function testSquadId(leader: TestMember): string {
  return squadIdFrom(leader.keys.publicKey, new Uint8Array(16).fill(7));
}

export function testCharter(members: TestMember[], overrides: Partial<Charter> = {}): Charter {
  const [leader] = members;
  if (!leader) throw new Error('A charter needs at least one member.');
  return {
    v: 1,
    type: 'charter',
    squadId: testSquadId(leader),
    name: 'Test squad',
    eventId: 'reinvent2026',
    leader: leader.memberId,
    seq: 1,
    issuedAt: '2026-10-05T18:00:00Z',
    expiresAt: '2026-12-18T00:00:00Z',
    inviteVerifier: toBase64Url(new Uint8Array(32).fill(1)),
    members: members.map((m, i) => ({
      memberId: m.memberId,
      name: m.name,
      publicKey: toBase64Url(m.keys.publicKey),
      role: i === 0 ? ('leader' as const) : ('member' as const),
      joinedAt: '2026-10-05T18:00:00Z',
    })),
    topics: [{ id: 'agentic', label: 'Agentic AI', weight: 5, target: 2 }],
    ...overrides,
  };
}

export function testManifest(
  member: TestMember,
  charter: Charter,
  overrides: Partial<Manifest> = {},
): Manifest {
  return {
    v: 1,
    type: 'manifest',
    squadId: charter.squadId,
    memberId: member.memberId,
    seq: 1,
    issuedAt: '2026-10-08T15:04:05Z',
    eventId: charter.eventId,
    catalogHash: `sha256:${'a'.repeat(64)}`,
    share: 'L0',
    sessions: [{ sessionId: 's-1', code: 'AGT301', status: 'reserved' }],
    ...overrides,
  };
}
