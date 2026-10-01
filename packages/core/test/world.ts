import type { CatalogSession } from '../src/catalog';
import { analyseCoverage } from '../src/coverage';
import type { Charter, Manifest, ManifestSession } from '../src/schemas';
import type { Proposal, SolverInput } from '../src/solver';
import { defaultVenueGraph } from '../src/venues';
import { session } from './catalog-builders';
import { testCharter, testManifest } from './helpers';
import { at, people, PST, snapshot } from './scenario';

// A random squad world built from a tape of integers (so fast-check can shrink it), plus checks
// that re-implement the rules of docs/03 independently of solver.ts.

const VENUES = ['wynn', 'venetian', 'caesars-forum', 'mgm-grand', 'mandalay-bay'] as const;
const TOPIC_LABELS = ['Security', 'Data', 'Agentic', 'Other'] as const;
const LENGTHS = [30, 45, 60, 90] as const;
const ALT_HASH = `sha256:${'b'.repeat(64)}`;

export interface World extends Omit<SolverInput, 'manifests'> {
  manifests: Manifest[];
  sessions: CatalogSession[];
}

export function buildWorld(tape: number[]): World {
  let i = 0;
  const next = (n: number): number => (tape[i++ % tape.length] as number) % n;

  const members = people.slice(0, 2 + next(3));
  const sessions: CatalogSession[] = [];
  const count = 6 + next(19);
  for (let k = 0; k < count; k++) {
    const start = at(8, 0, next(3)) + 15 * next(37);
    sessions.push(
      session({
        sessionId: `s${k}`,
        code: `AAA${100 + k}`,
        title: `Title ${k}`,
        venue: VENUES[next(5)] as string,
        topics: [TOPIC_LABELS[next(4)] as string],
        startMin: start,
        endMin: start + (LENGTHS[next(4)] as number),
        full: next(10) === 0,
      }),
    );
  }
  // Repeats: a clone of an earlier session with an -R1 code, on another day.
  const repeated = new Set<number>();
  for (let r = 0, n = next(4); r < n; r++) {
    const k = next(count);
    if (repeated.has(k)) continue;
    repeated.add(k);
    const source = sessions[k] as CatalogSession;
    const shift = (1 + next(2)) * 1440;
    sessions[k] = { ...source, code: `${source.code}-R` };
    sessions.push({
      ...source,
      sessionId: `r${r}`,
      code: `${source.code}-R1`,
      startMin: source.startMin + shift,
      endMin: source.endMin + shift,
      full: next(8) === 0,
    });
  }

  const tolerance = [0, 0.2, 0.5][next(3)] as number;
  const mustCover = sessions.filter(() => next(6) === 0).map((s) => ({ sessionId: s.sessionId }));
  const charter: Charter = testCharter(members, {
    topics: [
      { id: 'security', label: 'Security', weight: 4, target: 1, match: { topics: ['Security'] } },
      { id: 'data', label: 'Data', weight: 3, target: 1, match: { topics: ['Data'] } },
      { id: 'agentic', label: 'Agentic', weight: 5, target: 2, match: { topics: ['Agentic'] } },
    ],
    tolerance,
    mustCover,
    travel: { bufferMin: next(3) * 5 },
    ...(next(2) === 0 && { caps: { maxPerDay: 2 + next(5) } }),
    ...(next(2) === 0 && { lunch: { start: '12:00', end: '13:00', protected: true } }),
  });

  const manifests: Manifest[] = members.map((member) => {
    const held: ManifestSession[] = [];
    for (const s of sessions) {
      if (next(3) !== 0) continue;
      held.push({
        sessionId: s.sessionId,
        code: s.code,
        status: (['reserved', 'reserved', 'favorite', 'maybe'] as const)[
          next(4)
        ] as ManifestSession['status'],
        priority: 1 + next(5),
        ...(next(12) === 0 && { locked: true }),
        ...(next(20) === 0 && { role: 'speaker' as const }),
      });
    }
    const holds = sessions
      .filter(() => next(10) === 0)
      .map((s) => ({
        sessionId: s.sessionId,
        reason: (next(2) === 0 ? 'declined' : 'pinned') as 'declined' | 'pinned',
      }));
    return testManifest(member, charter, {
      sessions: held,
      ...(holds.length > 0 && { holds }),
      catalogHash: next(5) === 0 ? ALT_HASH : `sha256:${'a'.repeat(64)}`,
    });
  });

  const newSessions =
    next(3) === 0 ? [(sessions[next(sessions.length)] as CatalogSession).sessionId] : [];
  return {
    charter,
    manifests,
    catalog: snapshot(sessions),
    venueGraph: defaultVenueGraph,
    newSessions,
    sessions,
  };
}

// --- independent re-implementation of the rules ---------------------------------------------

export const heldOf = (m: Manifest) => m.sessions.filter((s) => s.status !== 'maybe');
export const lookup = (w: { sessions: CatalogSession[] }) =>
  new Map(w.sessions.map((s) => [s.sessionId, s]));
const localDayOf = (min: number) => Math.floor((min + PST) / 1440);
const localMinute = (min: number) => (((min + PST) % 1440) + 1440) % 1440;
const posOf = (venue: string) => defaultVenueGraph.venues.find((v) => v.id === venue)?.at;

function walk(a: string, b: string): number | undefined {
  if (a === b) return 0;
  const pa = posOf(a);
  const pb = posOf(b);
  return pa === undefined || pb === undefined ? undefined : Math.abs(pa - pb);
}

export function fits(charter: Charter, schedule: CatalogSession[], y: CatalogSession): boolean {
  if (y.full) return false;
  if (schedule.some((s) => s.startMin < y.endMin && y.startMin < s.endMin)) return false;
  if (charter.lunch?.protected) {
    const start = localMinute(y.startMin);
    if (start < 13 * 60 && start + (y.endMin - y.startMin) > 12 * 60) return false;
  }
  const cap = charter.caps?.maxPerDay;
  if (
    cap !== undefined &&
    schedule.filter((s) => localDayOf(s.startMin) === localDayOf(y.startMin)).length + 1 > cap
  ) {
    return false;
  }
  const buffer = charter.travel?.bufferMin ?? 0;
  const before = schedule
    .filter((s) => s.endMin <= y.startMin)
    .sort((a, b) => b.endMin - a.endMin)[0];
  const after = schedule
    .filter((s) => s.startMin >= y.endMin)
    .sort((a, b) => a.startMin - b.startMin)[0];
  const ok = (from: CatalogSession, to: CatalogSession) => {
    const w = walk(from.venue, to.venue);
    return w !== undefined && w + buffer <= to.startMin - from.endMin;
  };
  return (!before || ok(before, y)) && (!after || ok(y, after));
}

export function applyOne(
  manifests: Manifest[],
  p: Proposal,
  index: Map<string, CatalogSession>,
): Manifest[] {
  return manifests.map((m) => {
    if (m.memberId !== p.memberId) return m;
    const removed = m.sessions.filter((s) => p.remove?.includes(s.sessionId));
    const inherited = removed[0];
    const added = (p.add ?? []).map((id) => ({
      sessionId: id,
      code: index.get(id)?.code ?? 'AAA100',
      status: inherited?.status ?? ('favorite' as const),
      ...(inherited?.priority !== undefined && { priority: inherited.priority }),
    }));
    return {
      ...m,
      sessions: [...m.sessions.filter((s) => !p.remove?.includes(s.sessionId)), ...added],
    };
  });
}

export function value(w: SolverInput, manifests: Manifest[]): number {
  const report = analyseCoverage({ ...w, manifests });
  const weight = new Map(w.charter.topics.map((t) => [t.id, t.weight]));
  const coverage = report.cells.reduce(
    (sum, c) =>
      sum +
      Math.floor(((weight.get(c.topicId) ?? 0) * 1000 * Math.min(c.count, c.target)) / c.target),
    0,
  );
  const must = 3000 * ((w.charter.mustCover?.length ?? 0) - report.gaps.length);
  return (
    coverage +
    must -
    500 * report.duplicates.filter((d) => !d.planned).length -
    2000 * report.hops.length
  );
}

/** Hard constraints for one proposal against a set of manifests. Returns a problem or undefined. */
export function problem(w: World, manifests: Manifest[], p: Proposal): string | undefined {
  const index = lookup(w);
  const m = manifests.find((x) => x.memberId === p.memberId);
  if (!m) return 'unknown member';
  const held = heldOf(m);
  for (const id of p.remove ?? []) {
    const s = held.find((x) => x.sessionId === id);
    if (!s) return `removes ${id}, which the member does not hold`;
    if (s.locked === true || s.role === 'speaker') return `removes locked ${id}`;
    if (m.holds?.some((h) => h.sessionId === id && h.reason === 'pinned'))
      return `removes pinned ${id}`;
  }
  let schedule = held
    .filter((s) => !(p.remove ?? []).includes(s.sessionId))
    .flatMap((s) => (index.has(s.sessionId) ? [index.get(s.sessionId) as CatalogSession] : []));
  for (const id of p.add ?? []) {
    const y = index.get(id);
    if (!y) return `adds unknown ${id}`;
    if (m.holds?.some((h) => h.sessionId === id && h.reason === 'declined'))
      return `adds declined ${id}`;
    if (m.sessions.some((s) => s.sessionId === id)) return `adds ${id}, already listed`;
    if (!fits(w.charter, schedule, y)) return `adds ${id}, which does not fit`;
    schedule = [...schedule, y];
  }
  return undefined;
}

export const shuffled = <T>(items: T[], seed: number): T[] =>
  items
    .map((item, k) => ({ item, key: (seed * 2654435761 + k * 40503) % 1_000_003 }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
