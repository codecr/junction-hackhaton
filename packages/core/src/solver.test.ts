import { describe, expect, it } from 'vitest';
import { session } from '../test/catalog-builders';
import {
  ana,
  at,
  diego,
  hold,
  input,
  luis,
  manifestFor,
  marta,
  secSession,
  topicsCharter,
} from '../test/scenario';
import { applyProposal, personalValue, propose, squadValue } from './solver';
import type { ManifestSession } from './schemas';

const charter = topicsCharter();

// Scenario 1 of docs/01: Ana and Luis both hold OPS305-R, the topic target is 1, and the repeat
// OPS305-R1 exists on Wednesday.
const opsR = secSession('ops-r', 'OPS305-R', 10, 30, 60, { title: 'Guardrails' });
const opsR1 = secSession('ops-r1', 'OPS305-R1', 10, 30, 60, { title: 'Guardrails' }, 1);

const withPriority = (ids: string[], priority: number): ManifestSession[] =>
  ids.map((sessionId) => ({ sessionId, code: 'AGT301', status: 'reserved' as const, priority }));

describe('scenario 1: duplicate and its repeat', () => {
  const manifests = [
    manifestFor(ana, charter, hold('ops-r')),
    manifestFor(luis, charter, hold('ops-r')),
  ];

  it('proposes moving one of them to OPS305-R1, and only one', () => {
    const proposals = propose(input(charter, manifests, [opsR, opsR1]));
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p).toMatchObject({
      kind: 'SWAP',
      add: ['ops-r1'],
      remove: ['ops-r'],
      squadDelta: 4500, // duplicate gone (+500) and Wednesday security now covered (+4000)
      personalDelta: 0, // the swap keeps the session's priority
      reasons: ['repeat-available', 'raises-coverage', 'removes-duplicate'],
      provisional: false,
    });
    expect([ana.memberId, luis.memberId]).toContain(p?.memberId);
  });

  it('is worth only the duplicate (+500) when Wednesday security is already covered', () => {
    const wedSecurity = secSession('wed-sec', 'SEC301', 9, 0, 60, {}, 1);
    const covered = [
      manifestFor(ana, charter, hold('ops-r')),
      manifestFor(luis, charter, hold('ops-r')),
      manifestFor(marta, charter, hold('wed-sec')),
    ];
    const [p] = propose(input(charter, covered, [opsR, opsR1, wedSecurity]));
    expect(p).toMatchObject({
      kind: 'SWAP',
      squadDelta: 500,
      personalDelta: 0,
      reasons: ['repeat-available', 'removes-duplicate'],
    });
  });

  it('shows what differs between the repeats, for the "before you accept" step', () => {
    const [p] = propose(
      input(charter, manifests, [opsR, { ...opsR1, features: ['Customer story'] }]),
    );
    expect(p?.differences).toEqual(['features', 'start']);
  });

  it('gives the proposal a stable id that does not change between runs', () => {
    const a = propose(input(charter, manifests, [opsR, opsR1]))[0]!;
    const b = propose(input(charter, [...manifests].reverse(), [opsR1, opsR]))[0]!;
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toEqual(a);
  });

  it('proposes nothing when the repeat does not fit the member (an overlap), and drops only if the loss is allowed', () => {
    const clash = secSession('clash', 'AGT301', 10, 0, 90, {}, 1);
    const both = [
      manifestFor(ana, charter, hold('ops-r', 'clash')),
      manifestFor(luis, charter, hold('ops-r', 'clash')),
    ];
    const proposals = propose(input(charter, both, [opsR, opsR1, clash]));
    // Neither can take the repeat. Dropping loses 600 of a 1200 personal value, well over the 20% allowance.
    expect(proposals).toEqual([]);
  });

  it('does not offer a full repeat', () => {
    expect(propose(input(charter, manifests, [opsR, { ...opsR1, full: true }]))).toEqual([]);
  });
});

describe('the personal tolerance', () => {
  const crowded = [
    secSession('s1', 'SEC101', 9, 0, 30, { topics: ['Other'] }),
    secSession('s2', 'SEC102', 9, 45, 30, { topics: ['Other'] }),
    secSession('s3', 'SEC103', 14, 0, 30, { topics: ['Other'] }),
    secSession('s4', 'SEC104', 15, 0, 30, { topics: ['Other'] }),
  ];

  it('allows a drop when it costs at most the allowance (20% of 3,000)', () => {
    const five = ['ops-r', 's1', 's2', 's3', 's4'];
    const m = [manifestFor(ana, charter, hold(...five)), manifestFor(luis, charter, hold('ops-r'))];
    const drops = propose(input(charter, m, [opsR, ...crowded]));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      kind: 'DROP',
      remove: ['ops-r'],
      squadDelta: 500,
      personalDelta: -600,
    });
  });

  it('refuses the same drop for someone with fewer sessions (600 lost of 1,800 is over 20%)', () => {
    const m = [
      manifestFor(ana, charter, hold('ops-r', 's1', 's2')),
      manifestFor(luis, charter, hold('ops-r')),
    ];
    expect(propose(input(charter, m, [opsR, ...crowded]))).toEqual([]);
  });

  it('lets a low-priority session go when the high-priority one stays', () => {
    const m = [
      manifestFor(ana, charter, withPriority(['ops-r'], 1)),
      manifestFor(luis, charter, withPriority(['ops-r'], 5)),
    ];
    const [p] = propose(input(charter, m, [opsR]));
    // Ana loses 200 of a value of 200, Luis would lose 1,000 of 1,000. Neither is within 20%.
    expect(p).toBeUndefined();
  });

  it('uses the 20% default when the charter sets no tolerance', () => {
    const noTol = topicsCharter({ tolerance: undefined });
    const five = ['ops-r', 's1', 's2', 's3', 's4'];
    const m = [manifestFor(ana, noTol, hold(...five)), manifestFor(luis, noTol, hold('ops-r'))];
    expect(propose(input(noTol, m, [opsR, ...crowded]))[0]?.kind).toBe('DROP');
  });
});

describe('hard constraints', () => {
  const manifests = (extra: object = {}) => [
    manifestFor(ana, charter, hold('ops-r'), extra),
    manifestFor(luis, charter, hold('ops-r')),
  ];
  const sessions = [opsR, opsR1];
  const movedMembers = (m: ReturnType<typeof manifests>) =>
    propose(input(charter, m, sessions)).map((p) => p.memberId);

  it('never moves a locked session', () => {
    const lockedAna = [
      manifestFor(ana, charter, [
        { sessionId: 'ops-r', code: 'OPS305-R', status: 'reserved', locked: true },
      ]),
      manifestFor(luis, charter, hold('ops-r')),
    ];
    expect(movedMembers(lockedAna)).toEqual([luis.memberId]);
  });

  it('never moves a speaker session', () => {
    const speakerAna = [
      manifestFor(ana, charter, [
        { sessionId: 'ops-r', code: 'OPS305-R', status: 'reserved', role: 'speaker' },
      ]),
      manifestFor(luis, charter, hold('ops-r')),
    ];
    expect(movedMembers(speakerAna)).toEqual([luis.memberId]);
  });

  it('never removes a pinned session', () => {
    expect(movedMembers(manifests({ holds: [{ sessionId: 'ops-r', reason: 'pinned' }] }))).toEqual([
      luis.memberId,
    ]);
  });

  it('never adds a declined session, so a declined swap is not proposed again', () => {
    expect(
      movedMembers(manifests({ holds: [{ sessionId: 'ops-r1', reason: 'declined' }] })),
    ).toEqual([luis.memberId]);
  });

  it('offers the swap to the other member once the first declined it', () => {
    const [p] = propose(
      input(charter, manifests({ holds: [{ sessionId: 'ops-r1', reason: 'declined' }] }), sessions),
    );
    expect(p?.memberId).toBe(luis.memberId);
  });

  it('respects the per-day cap on the day it moves to', () => {
    const capped = topicsCharter({ caps: { maxPerDay: 1 } });
    const wedFull = secSession('wed', 'AGT301', 14, 0, 30, { topics: ['Other'] }, 1);
    const m = [
      manifestFor(ana, capped, hold('ops-r', 'wed')),
      manifestFor(luis, capped, hold('ops-r', 'wed')),
    ];
    // Both already have one session on Wednesday, so neither can add the repeat there.
    expect(propose(input(capped, m, [opsR, opsR1, wedFull]))).toEqual([]);
  });

  it('keeps the protected lunch free', () => {
    const lunchRepeat = secSession('ops-r1', 'OPS305-R1', 12, 0, 60, { title: 'Guardrails' }, 1);
    const withLunch = topicsCharter({ lunch: { start: '12:00', end: '13:00', protected: true } });
    const m = [
      manifestFor(ana, withLunch, hold('ops-r')),
      manifestFor(luis, withLunch, hold('ops-r')),
    ];
    expect(propose(input(withLunch, m, [opsR, lunchRepeat]))).toEqual([]);
  });
});

describe('claims', () => {
  const NEW = session({
    sessionId: 'new',
    code: 'AGT403',
    title: 'New session',
    venue: 'wynn',
    topics: ['Agentic'],
    startMin: at(16, 15),
    endMin: at(17, 15),
  });
  const mustCover = topicsCharter({ mustCover: [{ sessionId: 'new' }] });

  it('asks the owner under the claim rule to take an uncovered must-cover session', () => {
    const m = [ana, luis, marta].map((x) => manifestFor(x, mustCover, []));
    const proposals = propose(input(mustCover, m, [NEW]));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CLAIM',
      add: ['new'],
      // Must-cover 3000, plus agentic coverage: weight 5, target 2, one member of two = 2500.
      squadDelta: 3000 + 2500,
      personalDelta: 600,
      reasons: ['owner-by-claim-rule', 'covers-must-cover', 'raises-coverage'],
    });
  });

  it('is asked only of the one member with rank 0, not of everybody', () => {
    const m = [ana, luis, marta, diego].map((x) => manifestFor(x, mustCover, []));
    expect(propose(input(mustCover, m, [NEW])).map((p) => p.kind)).toEqual(['CLAIM']);
  });

  it('claims a session announced as new even when it is not must-cover', () => {
    const plain = topicsCharter();
    const m = [ana, luis].map((x) => manifestFor(x, plain, []));
    const proposals = propose(input(plain, m, [NEW], { newSessions: ['new'] }));
    expect(proposals[0]).toMatchObject({ kind: 'CLAIM', add: ['new'] });
    expect(propose(input(plain, m, [NEW]))).toEqual([]);
  });

  it('does not propose a claim when nobody can fit it (a must-cover that falls in the lunch)', () => {
    const lunch = secSession('sec301', 'SEC301', 12, 0, 60);
    const c = topicsCharter({
      mustCover: [{ sessionId: 'sec301' }],
      lunch: { start: '12:00', end: '13:00', protected: true },
    });
    const m = [ana, luis].map((x) => manifestFor(x, c, []));
    expect(propose(input(c, m, [lunch]))).toEqual([]);
  });

  it('does not propose a claim for a session someone already holds', () => {
    const m = [manifestFor(ana, mustCover, hold('new')), manifestFor(luis, mustCover, [])];
    expect(propose(input(mustCover, m, [NEW])).filter((p) => p.kind === 'CLAIM')).toEqual([]);
  });

  it('does not ask a member who declined it', () => {
    const solo = [
      manifestFor(ana, mustCover, [], { holds: [{ sessionId: 'new', reason: 'declined' }] }),
    ];
    expect(propose(input(mustCover, solo, [NEW]))).toEqual([]);
  });
});

describe('impossible connections', () => {
  // Luis leaves MGM Grand at 2:00 PM and starts at Mandalay Bay at 2:15 PM (28 min walk, 15 free).
  const a = secSession('a', 'DAT402', 13, 0, 60, { venue: 'mgm-grand', topics: ['Other'] });
  const b = secSession('b', 'DAT404', 14, 15, 60, { venue: 'mandalay-bay', topics: ['Other'] });

  it('fixes the connection by moving to a repeat that fits (+2000)', () => {
    const b1 = secSession(
      'b1',
      'DAT404-R1',
      16,
      0,
      60,
      { venue: 'mandalay-bay', topics: ['Other'], title: b.title },
      0,
    );
    const bRepeat = { ...b, title: b.title };
    const m = [manifestFor(luis, charter, hold('a', 'b'))];
    const [p] = propose(input(charter, m, [a, bRepeat, b1]));
    expect(p).toMatchObject({
      kind: 'SWAP',
      memberId: luis.memberId,
      add: ['b1'],
      remove: ['b'],
      squadDelta: 2000,
      personalDelta: 0,
      reasons: ['repeat-available', 'fixes-connection'],
    });
  });

  it('does not invent a drop for a bad connection: DROP is only for unplanned duplicates (docs/03)', () => {
    const m = [manifestFor(luis, charter, withPriority(['a', 'b'], 1))];
    expect(propose(input(charter, m, [a, b]))).toEqual([]);
  });
});

describe('provisional proposals', () => {
  it('are marked when the members catalog hashes differ', () => {
    const m = [
      manifestFor(ana, charter, hold('ops-r')),
      manifestFor(luis, charter, hold('ops-r'), { catalogHash: `sha256:${'b'.repeat(64)}` }),
    ];
    expect(propose(input(charter, m, [opsR, opsR1])).every((p) => p.provisional)).toBe(true);
  });
});

describe('values and bookkeeping', () => {
  it('computes the squad value with integer milli-units', () => {
    const m = [manifestFor(ana, charter, hold('ops-r')), manifestFor(luis, charter, hold('ops-r'))];
    const v = squadValue(input(charter, m, [opsR, opsR1]), m);
    // Security target 1, weight 4: 4000 on Tuesday. Wednesday has nobody: 0. One unplanned duplicate.
    expect(v).toEqual({ coverage: 4000, mustCover: 0, duplicates: -500, hops: 0, total: 3500 });
  });

  it('computes the personal value as priority times 200 per held session', () => {
    expect(personalValue(manifestFor(ana, charter, hold('a', 'b')))).toBe(1200);
    expect(personalValue(manifestFor(ana, charter, withPriority(['a'], 5)))).toBe(1000);
    const maybe: ManifestSession[] = [{ sessionId: 'a', code: 'AGT301', status: 'maybe' }];
    expect(personalValue(manifestFor(ana, charter, maybe))).toBe(0);
  });

  it('applyProposal reflects a swap and leaves other members alone', () => {
    const m = [manifestFor(ana, charter, hold('ops-r')), manifestFor(luis, charter, hold('ops-r'))];
    const i = input(charter, m, [opsR, opsR1]);
    const [p] = propose(i);
    const after = applyProposal(i, m, p!);
    const mover = after.find((x) => x.memberId === p!.memberId)!;
    const other = after.find((x) => x.memberId !== p!.memberId)!;
    expect(mover.sessions.map((s) => s.sessionId)).toEqual(['ops-r1']);
    expect(other.sessions.map((s) => s.sessionId)).toEqual(['ops-r']);
    expect(propose({ ...i, manifests: after })).toEqual([]);
  });

  it('keeps the highest seq when a member appears twice', () => {
    const old = manifestFor(ana, charter, hold('ops-r'), { seq: 1 });
    const fresh = manifestFor(ana, charter, [], { seq: 2 });
    const m = [old, fresh, manifestFor(luis, charter, hold('ops-r'))];
    expect(propose(input(charter, m, [opsR, opsR1]))).toEqual([]); // Ana's newer manifest holds nothing: no duplicate
  });

  it('returns nothing for an empty squad state', () => {
    expect(propose(input(charter, [], []))).toEqual([]);
  });
});

describe('regressions found by the property tests', () => {
  it('does not offer a DROP that would stop an earlier CLAIM from fitting (each proposal stands alone)', () => {
    // Luis: A at MGM 9:00-10:00, then x at Wynn 10:00-10:30 (a 66 minute walk in zero minutes),
    // and y, a must-cover at Wynn 11:00. y only fits because x sits just before it. Dropping x
    // would fix the broken connection, but would leave A (60 free minutes) to y (66 needed).
    // Marta also holds x (so it is an unplanned duplicate) but cannot take y: she holds z then.
    const A = secSession('A', 'AAA100', 9, 0, 60, { venue: 'mgm-grand', topics: ['Other'] });
    const x = secSession('x', 'AAA101', 10, 0, 30, { venue: 'wynn', topics: ['Other'] });
    const y = secSession('y', 'AAA102', 11, 0, 30, { venue: 'wynn', topics: ['Other'] });
    const z = secSession('z', 'AAA103', 11, 0, 30, { venue: 'wynn', topics: ['Other'] });
    const c = topicsCharter({ tolerance: 0.5, mustCover: [{ sessionId: 'y' }] });
    const m = [
      manifestFor(luis, c, withPriority(['A', 'x'], 1)),
      manifestFor(marta, c, withPriority(['x', 'z'], 1)),
    ];
    const proposals = propose(input(c, m, [A, x, y, z]));
    expect(proposals.find((p) => p.kind === 'CLAIM')?.memberId).toBe(luis.memberId);
    expect(
      proposals.find((p) => p.kind === 'DROP' && p.memberId === luis.memberId),
    ).toBeUndefined();
    // Marta can still release x, since that does not touch Luis's schedule.
    expect(proposals.find((p) => p.kind === 'DROP')?.memberId).toBe(marta.memberId);
  });

  it('keeps a must-cover session with its only holder, even for its own repeat', () => {
    const s4 = secSession('s4', 'AGT104-R', 10, 0, 60, { topics: ['Agentic'], title: 'Same' });
    const r1 = secSession('r1', 'AGT104-R1', 10, 0, 60, { topics: ['Agentic'], title: 'Same' }, 1);
    const c = topicsCharter({ mustCover: [{ sessionId: 's4' }, { sessionId: 'r1' }] });
    const m = [manifestFor(ana, c, hold('s4')), manifestFor(luis, c, [])];
    const swaps = propose(input(c, m, [s4, r1])).filter((p) => p.kind === 'SWAP');
    expect(swaps).toEqual([]);
  });

  it('lets a must-cover session go when another member also holds it', () => {
    const must = secSession('must', 'SEC200-R', 10, 0, 60, { title: 'Same' });
    const repeat = secSession('must1', 'SEC200-R1', 10, 0, 60, { title: 'Same' }, 1);
    const c = topicsCharter({ mustCover: [{ sessionId: 'must' }] });
    const m = [manifestFor(ana, c, hold('must')), manifestFor(luis, c, hold('must'))];
    const swaps = propose(input(c, m, [must, repeat])).filter((p) => p.kind === 'SWAP');
    expect(swaps).toHaveLength(1);
  });

  it('never trades one part of the squad value for another: a swap that costs must-cover is refused', () => {
    // The swap would raise Wednesday security coverage (+4000) but give up the must-cover (-3000).
    const must = secSession('must', 'SEC200-R', 10, 0, 60, { title: 'Same' });
    const repeat = secSession('must1', 'SEC200-R1', 10, 0, 60, { title: 'Same' }, 1);
    const c = topicsCharter({ mustCover: [{ sessionId: 'must' }] });
    const m = [manifestFor(ana, c, hold('must'))];
    expect(propose(input(c, m, [must, repeat]))).toEqual([]);
  });
});
