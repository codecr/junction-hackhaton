import { compareStrings } from './bytes';
import { indexSessions, type CatalogSession, type CatalogSnapshot } from './catalog';
import { localDay, localMinuteOfDay, parseClock } from './time';
import { normalizeText } from './text';
import type { Charter, Manifest, ManifestSession } from './schemas';
import { walkMinutes, type VenueGraph } from './venues';

export interface CoverageInput {
  charter: Charter;
  /** Verified manifests, one per member. Order does not matter. */
  manifests: readonly Manifest[];
  catalog: CatalogSnapshot;
  venueGraph: VenueGraph;
  /** Count `maybe` sessions as held. Default false. */
  includeMaybe?: boolean;
}

export type CoverageState = 'none' | 'under' | 'ok';

export interface CoverageCell {
  topicId: string;
  /** Event-local day number (days since epoch). */
  day: number;
  /** Members holding at least one session of this topic on this day, sorted. */
  members: string[];
  count: number;
  target: number;
  state: CoverageState;
  /** Sessions in the catalog for this topic on this day, so the UI can tell "nothing offered". */
  offered: number;
}

export interface Duplicate {
  sessionId: string;
  code: string;
  day: number;
  attendees: string[];
  /** Highest target among the topics the session matches, or 1 when it matches none. */
  target: number;
  /** Planned when attendees are at most the target. Otherwise nobody planned it. */
  planned: boolean;
}

export interface InfeasibleHop {
  memberId: string;
  day: number;
  fromSessionId: string;
  toSessionId: string;
  /** Walking minutes plus the charter buffer. */
  needMin: number;
  /** Minutes between the end of one session and the start of the next. Negative for an overlap. */
  haveMin: number;
  overlap: boolean;
}

export interface UnjudgedHop {
  memberId: string;
  fromSessionId: string;
  toSessionId: string;
}

export type GapReason = 'nobody' | 'not-in-catalog';

export interface MustCoverGap {
  sessionId: string;
  /** Undefined when the session is not in this catalog. */
  code: string | undefined;
  day: number | undefined;
  reason: GapReason;
  /** The session overlaps the protected squad lunch, which is why nobody may hold it. */
  collidesWithLunch: boolean;
}

export interface CoverageReport {
  /** Local days that have at least one session, ascending. */
  days: number[];
  cells: CoverageCell[];
  duplicates: Duplicate[];
  hops: InfeasibleHop[];
  unjudgedHops: UnjudgedHop[];
  gaps: MustCoverGap[];
  /** Manifest sessions this catalog does not contain. A sign the catalogs differ. */
  unknownSessions: { memberId: string; sessionId: string }[];
}

export function heldSessions(manifest: Manifest, includeMaybe = false): ManifestSession[] {
  return manifest.sessions.filter((s) => s.status !== 'maybe' || includeMaybe);
}

/** Topic ids from the charter that a session matches. A topic with no `match` matches nothing. */
export function topicIdsOf(session: CatalogSession, charter: Charter): string[] {
  const norm = (values: readonly string[] | undefined) =>
    new Set((values ?? []).map(normalizeText));
  const own = {
    topics: norm(session.topics),
    services: norm(session.services),
    tracks: norm(session.tracks),
  };
  const ids: string[] = [];
  for (const topic of charter.topics) {
    const match = topic.match;
    if (!match) continue;
    const hit =
      (match.topics ?? []).some((label) => own.topics.has(normalizeText(label))) ||
      (match.services ?? []).some((label) => own.services.has(normalizeText(label))) ||
      (match.tracks ?? []).some((label) => own.tracks.has(normalizeText(label)));
    if (hit) ids.push(topic.id);
  }
  return ids.sort(compareStrings);
}

export function targetOf(session: CatalogSession, charter: Charter): number {
  const targets = topicIdsOf(session, charter).map(
    (id) => charter.topics.find((t) => t.id === id)?.target ?? 1,
  );
  return targets.length === 0 ? 1 : Math.max(...targets);
}

/** Does the session overlap the protected lunch window on its local day? */
export function collidesWithLunch(
  session: CatalogSession,
  charter: Charter,
  utcOffsetMin: number,
): boolean {
  const lunch = charter.lunch;
  if (!lunch || !lunch.protected) return false;
  const from = parseClock(lunch.start);
  const to = parseClock(lunch.end);
  if (from === undefined || to === undefined) return false;
  const start = localMinuteOfDay(session.startMin, utcOffsetMin);
  const end = start + (session.endMin - session.startMin);
  return start < to && end > from;
}

const bySessionTime = (a: CatalogSession, b: CatalogSession): number =>
  a.startMin - b.startMin || a.endMin - b.endMin || compareStrings(a.sessionId, b.sessionId);

export function analyseCoverage(input: CoverageInput): CoverageReport {
  const { charter, catalog, venueGraph } = input;
  const includeMaybe = input.includeMaybe ?? false;
  const offset = catalog.utcOffsetMin;
  const buffer = charter.travel?.bufferMin ?? 0;
  const index = indexSessions(catalog.sessions);
  const manifests = [...input.manifests].sort((a, b) => compareStrings(a.memberId, b.memberId));

  const heldBy = new Map<string, Set<string>>(); // sessionId -> member ids
  const perMember = new Map<string, CatalogSession[]>();
  const unknownSessions: CoverageReport['unknownSessions'] = [];

  for (const manifest of manifests) {
    const sessions: CatalogSession[] = [];
    for (const held of heldSessions(manifest, includeMaybe)) {
      const session = index.get(held.sessionId);
      if (!session) {
        unknownSessions.push({ memberId: manifest.memberId, sessionId: held.sessionId });
        continue;
      }
      sessions.push(session);
      const holders = heldBy.get(session.sessionId) ?? new Set<string>();
      holders.add(manifest.memberId);
      heldBy.set(session.sessionId, holders);
    }
    perMember.set(manifest.memberId, sessions.sort(bySessionTime));
  }
  unknownSessions.sort(
    (a, b) => compareStrings(a.memberId, b.memberId) || compareStrings(a.sessionId, b.sessionId),
  );

  // Coverage matrix: topic by day.
  const days = [...new Set(catalog.sessions.map((s) => localDay(s.startMin, offset)))].sort(
    (a, b) => a - b,
  );
  const topicOfSession = new Map(
    catalog.sessions.map((s) => [s.sessionId, topicIdsOf(s, charter)]),
  );
  const cells: CoverageCell[] = [];
  for (const topic of charter.topics) {
    for (const day of days) {
      const members = new Set<string>();
      let offered = 0;
      for (const session of catalog.sessions) {
        if (localDay(session.startMin, offset) !== day) continue;
        if (!topicOfSession.get(session.sessionId)?.includes(topic.id)) continue;
        offered += 1;
        for (const memberId of heldBy.get(session.sessionId) ?? []) members.add(memberId);
      }
      const count = members.size;
      cells.push({
        topicId: topic.id,
        day,
        members: [...members].sort(compareStrings),
        count,
        target: topic.target,
        state: count === 0 ? 'none' : count < topic.target ? 'under' : 'ok',
        offered,
      });
    }
  }

  // Duplicates: one session held by more than one member.
  const duplicates: Duplicate[] = [];
  for (const [sessionId, holders] of heldBy) {
    if (holders.size < 2) continue;
    const session = index.get(sessionId) as CatalogSession;
    const target = targetOf(session, charter);
    duplicates.push({
      sessionId,
      code: session.code,
      day: localDay(session.startMin, offset),
      attendees: [...holders].sort(compareStrings),
      target,
      planned: holders.size <= target,
    });
  }
  duplicates.sort(
    (a, b) =>
      (index.get(a.sessionId)?.startMin ?? 0) - (index.get(b.sessionId)?.startMin ?? 0) ||
      compareStrings(a.sessionId, b.sessionId),
  );

  // Infeasible hops: walking plus buffer does not fit in the gap.
  const hops: InfeasibleHop[] = [];
  const unjudgedHops: UnjudgedHop[] = [];
  for (const manifest of manifests) {
    const sessions = perMember.get(manifest.memberId) ?? [];
    for (let i = 1; i < sessions.length; i++) {
      const from = sessions[i - 1] as CatalogSession;
      const to = sessions[i] as CatalogSession;
      const walk = walkMinutes(venueGraph, from.venue, to.venue);
      if (walk === undefined) {
        unjudgedHops.push({
          memberId: manifest.memberId,
          fromSessionId: from.sessionId,
          toSessionId: to.sessionId,
        });
        continue;
      }
      const needMin = walk + buffer;
      const haveMin = to.startMin - from.endMin;
      if (needMin > haveMin) {
        hops.push({
          memberId: manifest.memberId,
          day: localDay(to.startMin, offset),
          fromSessionId: from.sessionId,
          toSessionId: to.sessionId,
          needMin,
          haveMin,
          overlap: haveMin < 0,
        });
      }
    }
  }

  // Must-cover sessions nobody holds.
  const gaps: MustCoverGap[] = [];
  for (const { sessionId } of charter.mustCover ?? []) {
    if ((heldBy.get(sessionId)?.size ?? 0) > 0) continue;
    const session = index.get(sessionId);
    gaps.push({
      sessionId,
      code: session?.code,
      day: session ? localDay(session.startMin, offset) : undefined,
      reason: session ? 'nobody' : 'not-in-catalog',
      collidesWithLunch: session ? collidesWithLunch(session, charter, offset) : false,
    });
  }

  return { days, cells, duplicates, hops, unjudgedHops, gaps, unknownSessions };
}

/** Issues on one local day, for the day tabs: unplanned duplicates, impossible hops, uncovered must-covers. */
export function issuesOnDay(report: CoverageReport, day: number): number {
  return (
    report.duplicates.filter((d) => d.day === day && !d.planned).length +
    report.hops.filter((h) => h.day === day).length +
    report.gaps.filter((g) => g.day === day).length
  );
}
