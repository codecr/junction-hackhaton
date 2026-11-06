import { compareStrings } from './bytes';
import { indexSessions, type CatalogSnapshot } from './catalog';
import { analyseCoverage, topicIdsOf, issuesOnDay, type CoverageReport } from './coverage';
import { propose, type Proposal } from './solver';
import { civilFromDays, localDay, localMinuteOfDay } from './time';
import { venueOrder, type VenueGraph } from './venues';
import {
  priorityOf,
  isLocked,
  type Charter,
  type Manifest,
  type SessionStatus,
  type ShareLevel,
} from './schemas';

// The one shape the UI and the local MCP server read. Pure: built from the same inputs as the
// solver, so every machine renders the same squad. Titles come only from the local catalog.

export const MEMBER_COLORS = ['--m1', '--m2', '--m3', '--m4', '--m5'] as const;
export const MEMBER_SHAPES = ['circle', 'square', 'diamond', 'triangle', 'cross'] as const;
export type MemberShape = (typeof MEMBER_SHAPES)[number];

export interface ViewMember {
  memberId: string;
  name: string;
  role: 'leader' | 'member';
  color: string;
  shape: MemberShape;
  /** Lightness step for squads larger than five (0 for the first five). */
  tone: number;
  hasPicks: boolean;
  share: ShareLevel | undefined;
  catalogHash: string | undefined;
}

export interface ViewSession {
  sessionId: string;
  code: string;
  title: string;
  type: string | undefined;
  level: string | undefined;
  startMin: number;
  endMin: number;
  day: number;
  /** Minute of the event-local day. */
  startLocal: number;
  endLocal: number;
  venue: string;
  room: string | undefined;
  topicIds: string[];
  full: boolean;
  mustCover: boolean;
}

export interface ViewHolding {
  memberId: string;
  sessionId: string;
  status: SessionStatus;
  priority: number;
  locked: boolean;
}

export interface ViewDay {
  day: number;
  y: number;
  m: number;
  d: number;
  /** 0 Sunday to 6 Saturday. */
  weekday: number;
  issues: number;
}

export interface SquadView {
  squadId: string;
  squadName: string;
  eventId: string;
  utcOffsetMin: number;
  me: string | undefined;
  provisional: boolean;
  members: ViewMember[];
  venues: { id: string; name: string; at: number }[];
  venueApproximate: boolean;
  topics: { id: string; label: string; weight: number; target: number }[];
  lunch: { startLocal: number; endLocal: number; protected: boolean } | undefined;
  days: ViewDay[];
  /** Held, proposed and must-cover sessions, keyed by id. */
  sessions: Record<string, ViewSession>;
  holdings: ViewHolding[];
  coverage: CoverageReport;
  proposals: Proposal[];
}

export interface SquadViewInput {
  charter: Charter;
  manifests: readonly Manifest[];
  catalog: CatalogSnapshot;
  venueGraph: VenueGraph;
  /** The member viewing, when known. */
  me?: string;
  newSessions?: readonly string[];
}

function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function buildSquadView(input: SquadViewInput): SquadView {
  const { charter, catalog, venueGraph } = input;
  const latest = new Map<string, Manifest>();
  for (const m of input.manifests) {
    const prev = latest.get(m.memberId);
    if (!prev || m.seq > prev.seq) latest.set(m.memberId, m);
  }
  const manifests = [...latest.values()].sort((a, b) => compareStrings(a.memberId, b.memberId));

  const coverage = analyseCoverage({ charter, manifests, catalog, venueGraph });
  const proposals = propose({
    charter,
    manifests,
    catalog,
    venueGraph,
    ...(input.newSessions ? { newSessions: input.newSessions } : {}),
  });

  const members: ViewMember[] = charter.members.map((cm, i) => {
    const m = latest.get(cm.memberId);
    return {
      memberId: cm.memberId,
      name: cm.name,
      role: cm.role,
      color: MEMBER_COLORS[i % MEMBER_COLORS.length]!,
      // Past five members the shape shifts by one per round, so no colour and shape pair repeats.
      shape: MEMBER_SHAPES[(i + Math.floor(i / MEMBER_COLORS.length)) % MEMBER_SHAPES.length]!,
      tone: Math.floor(i / MEMBER_COLORS.length),
      hasPicks: m !== undefined,
      share: m?.share,
      catalogHash: m?.catalogHash,
    };
  });

  const mustCover = new Set((charter.mustCover ?? []).map((s) => s.sessionId));
  const wanted = new Set<string>(mustCover);
  const holdings: ViewHolding[] = [];
  for (const m of manifests) {
    for (const s of m.sessions) {
      wanted.add(s.sessionId);
      holdings.push({
        memberId: m.memberId,
        sessionId: s.sessionId,
        status: s.status,
        priority: priorityOf(s),
        locked: isLocked(s),
      });
    }
  }
  for (const p of proposals)
    for (const id of [...(p.add ?? []), ...(p.remove ?? [])]) wanted.add(id);

  const byId = indexSessions(catalog.sessions);
  const sessions: Record<string, ViewSession> = {};
  for (const id of [...wanted].sort(compareStrings)) {
    const s = byId.get(id);
    if (!s) continue;
    sessions[id] = {
      sessionId: s.sessionId,
      code: s.code,
      title: s.title,
      type: s.type,
      level: s.level,
      startMin: s.startMin,
      endMin: s.endMin,
      day: localDay(s.startMin, catalog.utcOffsetMin),
      startLocal: localMinuteOfDay(s.startMin, catalog.utcOffsetMin),
      endLocal: localMinuteOfDay(s.startMin, catalog.utcOffsetMin) + (s.endMin - s.startMin),
      venue: s.venue,
      room: s.room,
      topicIds: topicIdsOf(s, charter),
      full: s.full === true,
      mustCover: mustCover.has(s.sessionId),
    };
  }

  const days: ViewDay[] = coverage.days.map((day) => {
    const { y, m, d } = civilFromDays(day);
    return { day, y, m, d, weekday: (((day + 4) % 7) + 7) % 7, issues: issuesOnDay(coverage, day) };
  });

  const order = venueOrder(venueGraph);
  const venueById = new Map(venueGraph.venues.map((v) => [v.id, v]));

  return {
    squadId: charter.squadId,
    squadName: charter.name,
    eventId: charter.eventId,
    utcOffsetMin: catalog.utcOffsetMin,
    me: input.me,
    provisional:
      proposals.some((p) => p.provisional) || new Set(manifests.map((m) => m.catalogHash)).size > 1,
    members,
    venues: order.map((id) => {
      const v = venueById.get(id)!;
      return { id: v.id, name: v.name, at: v.at };
    }),
    venueApproximate: venueGraph.approximate === true,
    topics: charter.topics.map((t) => ({
      id: t.id,
      label: t.label,
      weight: t.weight,
      target: t.target,
    })),
    lunch: charter.lunch
      ? {
          startLocal: clockMinutes(charter.lunch.start),
          endLocal: clockMinutes(charter.lunch.end),
          protected: charter.lunch.protected,
        }
      : undefined,
    days,
    sessions,
    holdings,
    coverage,
    proposals,
  };
}
