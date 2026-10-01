import { describe, expect, it } from 'vitest';
import { testCharter, testManifest, testMember } from '../../test/helpers';
import { charterSchema, claimSchema, manifestSchema, signalSchema, envelopeSchema } from './index';

const ana = testMember('Ana', 1);
const luis = testMember('Luis', 2);
const charter = testCharter([ana, luis]);

describe('charter', () => {
  it('accepts a complete charter', () => {
    const full = testCharter([ana, luis], {
      topics: [
        {
          id: 'agentic',
          label: 'Agentic AI',
          weight: 5,
          target: 2,
          match: { topics: ['Agentic AI'], services: ['Amazon Bedrock'], tracks: ['AI'] },
        },
      ],
      mustCover: [{ sessionId: 's-9' }],
      lunch: { start: '12:00', end: '13:00', protected: true },
      caps: { maxPerDay: 5 },
      travel: { bufferMin: 5 },
      tolerance: 0.2,
    });
    expect(charterSchema.safeParse(full).success).toBe(true);
  });

  it('rejects unknown fields, so nothing extra can ride along', () => {
    expect(charterSchema.safeParse({ ...charter, email: 'a@b.c' }).success).toBe(false);
  });

  it('rejects bad ids, weights and clocks', () => {
    expect(charterSchema.safeParse({ ...charter, squadId: 'sq_SHORT' }).success).toBe(false);
    expect(
      charterSchema.safeParse({ ...charter, topics: [{ id: 'x', label: 'X', weight: 6, target: 1 }] }).success,
    ).toBe(false);
    expect(
      charterSchema.safeParse({ ...charter, lunch: { start: '25:00', end: '13:00', protected: true } }).success,
    ).toBe(false);
  });

  it('needs at least one member', () => {
    expect(charterSchema.safeParse({ ...charter, members: [] }).success).toBe(false);
  });
});

describe('manifest', () => {
  const base = testManifest(ana, charter);

  it('accepts a minimal L0 manifest', () => {
    expect(manifestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts holds at every sharing level', () => {
    const holds = [
      { sessionId: 's-2', reason: 'declined' as const },
      { sessionId: 's-3', reason: 'pinned' as const },
    ];
    for (const share of ['L0', 'L1', 'L2'] as const) {
      expect(manifestSchema.safeParse({ ...base, share, holds }).success).toBe(true);
    }
  });

  it('rejects an unknown hold reason', () => {
    expect(
      manifestSchema.safeParse({ ...base, holds: [{ sessionId: 's-2', reason: 'maybe-later' }] }).success,
    ).toBe(false);
  });

  it('allows busy blocks at L1 and L2 only', () => {
    const busy = [{ start: '2026-12-01T18:30:00Z', end: '2026-12-01T19:30:00Z' }];
    expect(manifestSchema.safeParse({ ...base, share: 'L0', busy }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, share: 'L1', busy }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, share: 'L2', busy }).success).toBe(true);
  });

  it('allows the venue at L2 only', () => {
    const at = { venue: 'venetian', since: '2026-12-01T18:00:00Z' };
    expect(manifestSchema.safeParse({ ...base, share: 'L1', at }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, share: 'L2', at }).success).toBe(true);
  });

  it('never carries titles or other catalog fields (privacy rule 2)', () => {
    const withTitle = {
      ...base,
      sessions: [{ sessionId: 's-1', code: 'AGT301', status: 'reserved', title: 'Agent memory in production' }],
    };
    expect(manifestSchema.safeParse(withTitle).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, room: 'Room 1' }).success).toBe(false);
  });

  it('rejects the same session twice', () => {
    const dup = { sessionId: 's-1', code: 'AGT301', status: 'favorite' as const };
    expect(manifestSchema.safeParse({ ...base, sessions: [...base.sessions, dup] }).success).toBe(false);
  });

  it('rejects bad codes, priorities and hashes', () => {
    const session = (code: string, priority?: number) => ({
      ...base,
      sessions: [{ sessionId: 's-1', code, status: 'reserved' as const, ...(priority ? { priority } : {}) }],
    });
    expect(manifestSchema.safeParse(session('agt301')).success).toBe(false);
    expect(manifestSchema.safeParse(session('AGT301', 6)).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, catalogHash: 'sha256:xyz' }).success).toBe(false);
  });

  it('accepts the observed code shapes, including repeats', () => {
    for (const code of ['COM302', 'COM302-R', 'COM302-R1', 'OPS305-R1', 'AGT4012']) {
      const m = { ...base, sessions: [{ sessionId: 's-1', code, status: 'reserved' as const }] };
      expect(manifestSchema.safeParse(m).success, code).toBe(true);
    }
  });

  it('caps the size of every list', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      sessionId: `s-${i}`,
      code: 'AGT301',
      status: 'favorite' as const,
    }));
    expect(manifestSchema.safeParse({ ...base, sessions: many }).success).toBe(false);
  });
});

describe('signal and claim', () => {
  const signal = {
    v: 1 as const,
    type: 'signal' as const,
    squadId: charter.squadId,
    memberId: ana.memberId,
    sessionId: 's-1',
    code: 'OPS305-R',
    verdict: 'worth-it' as const,
    note: 'Bring a laptop.',
    issuedAt: '2026-12-01T20:00:00Z',
  };
  const claim = {
    v: 1 as const,
    type: 'claim' as const,
    squadId: charter.squadId,
    memberId: ana.memberId,
    sessionId: 's-1',
    rank: 0,
    issuedAt: '2026-12-01T20:00:00Z',
  };

  it('accepts valid ones', () => {
    expect(signalSchema.safeParse(signal).success).toBe(true);
    expect(claimSchema.safeParse(claim).success).toBe(true);
  });

  it('limits a scout note to 140 characters', () => {
    expect(signalSchema.safeParse({ ...signal, note: 'x'.repeat(140) }).success).toBe(true);
    expect(signalSchema.safeParse({ ...signal, note: 'x'.repeat(141) }).success).toBe(false);
  });

  it('rejects an unknown verdict and a negative rank', () => {
    expect(signalSchema.safeParse({ ...signal, verdict: 'meh' }).success).toBe(false);
    expect(claimSchema.safeParse({ ...claim, rank: -1 }).success).toBe(false);
  });
});

describe('envelope', () => {
  it('requires the four fields and the Ed25519 algorithm', () => {
    const good = { kid: ana.memberId, alg: 'Ed25519', payload: 'e30', sig: 'AAAA' };
    expect(envelopeSchema.safeParse(good).success).toBe(true);
    expect(envelopeSchema.safeParse({ ...good, alg: 'RS256' }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...good, payload: 'has space' }).success).toBe(false);
  });
});
