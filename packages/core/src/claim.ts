import { compareStrings, sha256Hex } from './bytes';
import type { CatalogSnapshot } from './catalog';
import { heldSessions, topicIdsOf } from './coverage';
import { canAdd, makeContext } from './feasibility';
import type { Charter, Manifest } from './schemas';
import { localDay } from './time';
import type { VenueGraph } from './venues';

/** Rank r may claim after the announcement plus r times this many minutes (docs/03). */
export const CLAIM_GRACE_MIN = 5;

export interface ClaimInput {
  charter: Charter;
  manifests: readonly Manifest[];
  catalog: CatalogSnapshot;
  venueGraph: VenueGraph;
}

export interface ClaimRank {
  memberId: string;
  /** 0 is the owner. */
  rank: number;
}

/**
 * The launch claim rule. For a session that appeared in the catalog:
 * 1. Eligible members are those who can fit it: no overlap, walking fits, cap respected, lunch and
 *    fullness fine, not declined. Members carry no personal topic list, so eligibility does not
 *    filter by topic; the session's topics only drive the ranking below.
 * 2. Rank by (their sessions that day in the same topics, ascending), (all their sessions that day,
 *    ascending), then lower-case hex of sha256(memberId + ":" + sessionId), ascending.
 * Pure: the same inputs give the same ranks on every machine. Rank 0 is the owner.
 */
export function rankClaimants(input: ClaimInput, sessionId: string): ClaimRank[] {
  const ctx = makeContext(input.charter, input.catalog, input.venueGraph);
  const session = ctx.index.get(sessionId);
  if (!session) return [];
  const offset = input.catalog.utcOffsetMin;
  const day = localDay(session.startMin, offset);
  const topics = new Set(topicIdsOf(session, input.charter));

  const scored: { memberId: string; topicToday: number; today: number; tiebreak: string }[] = [];
  for (const manifest of input.manifests) {
    if (manifest.holds?.some((h) => h.sessionId === sessionId && h.reason === 'declined')) continue;
    const held = heldSessions(manifest)
      .map((s) => ctx.index.get(s.sessionId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (!canAdd(ctx, held, session)) continue;
    const sameDay = held.filter((h) => localDay(h.startMin, offset) === day);
    scored.push({
      memberId: manifest.memberId,
      topicToday: sameDay.filter((h) => topicIdsOf(h, input.charter).some((id) => topics.has(id)))
        .length,
      today: sameDay.length,
      tiebreak: sha256Hex(`${manifest.memberId}:${sessionId}`),
    });
  }
  scored.sort(
    (a, b) =>
      a.topicToday - b.topicToday ||
      a.today - b.today ||
      compareStrings(a.tiebreak, b.tiebreak) ||
      compareStrings(a.memberId, b.memberId),
  );
  return scored.map((s, rank) => ({ memberId: s.memberId, rank }));
}

/** Seconds since the epoch at which this rank may start claiming. */
export function claimOpensAtSec(announceSec: number, rank: number): number {
  return announceSec + rank * CLAIM_GRACE_MIN * 60;
}

/** May a member of this rank claim at `nowSec`? The caller supplies the clock (rule 10). */
export function mayClaim(rank: number, announceSec: number, nowSec: number): boolean {
  return nowSec >= claimOpensAtSec(announceSec, rank);
}
