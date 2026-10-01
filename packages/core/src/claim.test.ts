import { createHash } from 'node:crypto';
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
  topicsCharter,
} from '../test/scenario';
import { CLAIM_GRACE_MIN, claimOpensAtSec, mayClaim, rankClaimants } from './claim';
import type { Manifest } from './schemas';

const charter = topicsCharter();
const NEW = session({
  sessionId: 'new',
  code: 'AGT403',
  title: 'Brand new session',
  venue: 'wynn',
  topics: ['Agentic'],
  startMin: at(16, 15),
  endMin: at(17, 15),
});
const agentic = (id: string, startH: number, venue = 'wynn', lengthMin = 60) =>
  session({
    sessionId: id,
    code: `AGT${300 + id.length}`,
    title: `T ${id}`,
    venue,
    topics: ['Agentic'],
    startMin: at(startH),
    endMin: at(startH) + lengthMin,
  });
const dataSession = (id: string, startH: number, venue = 'wynn') =>
  session({
    sessionId: id,
    code: 'DAT301',
    title: `T ${id}`,
    venue,
    topics: ['Data'],
    startMin: at(startH),
    endMin: at(startH) + 60,
  });

const rank = (manifests: Manifest[], sessions: ReturnType<typeof session>[], id = 'new') =>
  rankClaimants(input(charter, manifests, sessions), id).map((r) => r.memberId);

describe('rankClaimants', () => {
  it('puts the member with fewer sessions in the same topics that day first', () => {
    const a1 = agentic('a1', 9);
    const l1 = agentic('l1', 10);
    const l2 = agentic('l2', 11);
    const order = rank(
      [
        manifestFor(ana, charter, hold('a1')),
        manifestFor(luis, charter, hold('l1', 'l2')),
        manifestFor(marta, charter, []),
      ],
      [a1, l1, l2, NEW],
    );
    expect(order).toEqual([marta.memberId, ana.memberId, luis.memberId]);
  });

  it('breaks a topic tie by total sessions that day', () => {
    const d1 = dataSession('d1', 9);
    const d2 = dataSession('d2', 10);
    const order = rank(
      [manifestFor(ana, charter, hold('d1', 'd2')), manifestFor(luis, charter, hold('d1'))],
      [d1, d2, NEW],
    );
    expect(order).toEqual([luis.memberId, ana.memberId]);
  });

  it('breaks a full tie with sha256(memberId:sessionId), compared as lower-case hex', () => {
    const expected = [ana, luis, marta]
      .map((m) => ({
        id: m.memberId,
        h: createHash('sha256').update(`${m.memberId}:new`).digest('hex'),
      }))
      .sort((a, b) => (a.h < b.h ? -1 : 1))
      .map((x) => x.id);
    const order = rank(
      [ana, luis, marta].map((m) => manifestFor(m, charter, [])),
      [NEW],
    );
    expect(order).toEqual(expected);
  });

  it('counts only the sessions of the same day', () => {
    const otherDay = session({ ...agentic('x', 9), startMin: at(9, 0, 1), endMin: at(10, 0, 1) });
    const sameDay = agentic('y', 9);
    const order = rank(
      [manifestFor(ana, charter, hold('x', 'x')), manifestFor(luis, charter, hold('y'))].map(
        (m, i) =>
          i === 0
            ? { ...m, sessions: [{ sessionId: 'x', code: 'AGT301', status: 'reserved' as const }] }
            : m,
      ),
      [otherDay, sameDay, NEW],
    );
    expect(order).toEqual([ana.memberId, luis.memberId]);
  });

  it('leaves out members who cannot fit it: overlap, a walk that does not fit, a declined hold', () => {
    const clash = agentic('clash', 16, 'wynn');
    const farAway = agentic('far', 14, 'mandalay-bay'); // ends 15:00, 75 min before, needs 94
    const manifests = [
      manifestFor(ana, charter, hold('clash')),
      manifestFor(luis, charter, hold('far')),
      manifestFor(marta, charter, [], { holds: [{ sessionId: 'new', reason: 'declined' }] }),
      manifestFor(diego, charter, []),
    ];
    expect(rank(manifests, [clash, farAway, NEW])).toEqual([diego.memberId]);
  });

  it('returns nothing for an unknown session', () => {
    expect(rank([manifestFor(ana, charter, [])], [NEW], 'ghost')).toEqual([]);
  });

  it('numbers ranks from 0 and gives the same answer whatever the manifest order', () => {
    const manifests = [ana, luis, marta, diego].map((m) => manifestFor(m, charter, []));
    const forward = rankClaimants(input(charter, manifests, [NEW]), 'new');
    const reversed = rankClaimants(input(charter, [...manifests].reverse(), [NEW]), 'new');
    expect(reversed).toEqual(forward);
    expect(forward.map((r) => r.rank)).toEqual([0, 1, 2, 3]);
  });
});

describe('the grace period', () => {
  it('opens at the announcement plus rank times five minutes', () => {
    expect(CLAIM_GRACE_MIN).toBe(5);
    expect(claimOpensAtSec(1_000, 0)).toBe(1_000);
    expect(claimOpensAtSec(1_000, 3)).toBe(1_000 + 900);
  });

  it('refuses a claim before the window and allows it from the first second', () => {
    expect(mayClaim(0, 1_000, 999)).toBe(false);
    expect(mayClaim(0, 1_000, 1_000)).toBe(true);
    expect(mayClaim(2, 1_000, 1_000 + 599)).toBe(false);
    expect(mayClaim(2, 1_000, 1_000 + 600)).toBe(true);
  });
});
