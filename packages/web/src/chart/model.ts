import type { InfeasibleHop, SquadView, ViewMember, ViewSession } from '@junction/core';

// What one day of the squad looks like, derived from the SquadView. Pure; the chart, the list
// alternative and the summary sentence all read from this, so they never disagree.

export interface DayHop {
  from: ViewSession;
  to: ViewSession;
  walkMin: number;
  impossible: InfeasibleHop | undefined;
}

export interface DayRun {
  member: ViewMember;
  index: number;
  sessions: ViewSession[];
  hops: DayHop[];
}

export interface DayShared {
  session: ViewSession;
  members: ViewMember[];
  planned: boolean;
}

export interface DayOpen {
  session: ViewSession;
  /** A member a CLAIM proposal asks to take it. */
  owner: ViewMember | undefined;
  collidesWithLunch: boolean;
}

export interface DayModel {
  day: number;
  runs: DayRun[];
  shared: DayShared[];
  open: DayOpen[];
  hops: InfeasibleHop[];
  unplanned: number;
  /** Sessions held on this day at a venue the chart cannot place. */
  unplaced: ViewSession[];
}

const byTime = (a: ViewSession, b: ViewSession) =>
  a.startLocal - b.startLocal ||
  a.endLocal - b.endLocal ||
  (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

export function dayModel(view: SquadView, day: number): DayModel {
  const at = new Map(view.venues.map((v) => [v.id, v.at]));
  const memberById = new Map(view.members.map((m) => [m.memberId, m]));
  const hops = view.coverage.hops.filter((h) => h.day === day);
  const unplaced: ViewSession[] = [];

  const runs: DayRun[] = view.members.map((member, index) => {
    const sessions = view.holdings
      .filter((h) => h.memberId === member.memberId && h.status !== 'maybe')
      .map((h) => view.sessions[h.sessionId])
      .filter((s): s is ViewSession => s !== undefined && s.day === day)
      .filter((s) => {
        if (at.has(s.venue)) return true;
        unplaced.push(s);
        return false;
      })
      .sort(byTime);
    const memberHops: DayHop[] = [];
    for (let i = 1; i < sessions.length; i++) {
      const from = sessions[i - 1]!;
      const to = sessions[i]!;
      memberHops.push({
        from,
        to,
        walkMin: Math.abs((at.get(to.venue) ?? 0) - (at.get(from.venue) ?? 0)),
        impossible: hops.find(
          (h) =>
            h.memberId === member.memberId &&
            h.fromSessionId === from.sessionId &&
            h.toSessionId === to.sessionId,
        ),
      });
    }
    return { member, index, sessions, hops: memberHops };
  });

  const shared: DayShared[] = view.coverage.duplicates
    .filter((d) => d.day === day && view.sessions[d.sessionId] && at.has(view.sessions[d.sessionId]!.venue))
    .map((d) => ({
      session: view.sessions[d.sessionId]!,
      members: d.attendees.map((id) => memberById.get(id)).filter((m): m is ViewMember => !!m),
      planned: d.planned,
    }));

  const claims = new Map<string, string>();
  for (const p of view.proposals)
    if (p.kind === 'CLAIM') for (const id of p.add ?? []) if (!claims.has(id)) claims.set(id, p.memberId);

  const open: DayOpen[] = view.coverage.gaps
    .filter((g) => g.day === day && g.reason === 'nobody')
    .map((g) => view.sessions[g.sessionId] && { g, s: view.sessions[g.sessionId]! })
    .filter((x): x is { g: (typeof view.coverage.gaps)[number]; s: ViewSession } => !!x && at.has(x.s.venue))
    .map(({ g, s }) => {
      const ownerId = claims.get(s.sessionId);
      return {
        session: s,
        owner: ownerId ? memberById.get(ownerId) : undefined,
        collidesWithLunch: g.collidesWithLunch,
      };
    });

  return {
    day,
    runs,
    shared,
    open,
    hops,
    unplanned: view.coverage.duplicates.filter((d) => d.day === day && !d.planned).length,
    unplaced,
  };
}

/** Members holding a session on this day, in squad order. */
export function attendeesOf(model: DayModel, sessionId: string): ViewMember[] {
  return model.runs.filter((r) => r.sessions.some((s) => s.sessionId === sessionId)).map((r) => r.member);
}

/** The day to open on: the first day with something to fix, otherwise the first day. */
export function initialDay(view: SquadView, todayLocal?: number): number | undefined {
  if (todayLocal !== undefined && view.days.some((d) => d.day === todayLocal)) return todayLocal;
  return (view.days.find((d) => d.issues > 0) ?? view.days[0])?.day;
}
