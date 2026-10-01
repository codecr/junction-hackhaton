import { indexSessions, type CatalogSession, type CatalogSnapshot } from './catalog';
import { collidesWithLunch } from './coverage';
import type { Charter } from './schemas';
import { localDay } from './time';
import { walkMinutes, type VenueGraph } from './venues';

export interface FeasibilityContext {
  charter: Charter;
  catalog: CatalogSnapshot;
  venueGraph: VenueGraph;
  index: Map<string, CatalogSession>;
  bufferMin: number;
  maxPerDay: number | undefined;
}

export function makeContext(
  charter: Charter,
  catalog: CatalogSnapshot,
  venueGraph: VenueGraph,
): FeasibilityContext {
  return {
    charter,
    catalog,
    venueGraph,
    index: indexSessions(catalog.sessions),
    bufferMin: charter.travel?.bufferMin ?? 0,
    maxPerDay: charter.caps?.maxPerDay,
  };
}

const overlaps = (a: CatalogSession, b: CatalogSession): boolean =>
  a.startMin < b.endMin && b.startMin < a.endMin;

/** True when walking plus the buffer fits between two sessions. Unknown venues do not fit. */
function connects(ctx: FeasibilityContext, from: CatalogSession, to: CatalogSession): boolean {
  const walk = walkMinutes(ctx.venueGraph, from.venue, to.venue);
  if (walk === undefined) return false;
  return walk + ctx.bufferMin <= to.startMin - from.endMin;
}

/**
 * Can this member add `session` to the sessions they hold? Hard constraints from docs/03:
 * no time overlap, walking plus buffer fits on both sides, the per-day cap holds, the protected
 * lunch is not overlapped, and the session is not full. `held` must not contain `session`.
 * In the solver an unknown walking time counts as not feasible (conservative).
 */
export function canAdd(
  ctx: FeasibilityContext,
  held: readonly CatalogSession[],
  session: CatalogSession,
): boolean {
  if (session.full === true) return false;
  if (held.some((h) => h.sessionId === session.sessionId)) return false;
  if (held.some((h) => overlaps(h, session))) return false;
  if (collidesWithLunch(session, ctx.charter, ctx.catalog.utcOffsetMin)) return false;

  if (ctx.maxPerDay !== undefined) {
    const day = localDay(session.startMin, ctx.catalog.utcOffsetMin);
    const sameDay = held.filter((h) => localDay(h.startMin, ctx.catalog.utcOffsetMin) === day);
    if (sameDay.length + 1 > ctx.maxPerDay) return false;
  }

  let previous: CatalogSession | undefined;
  let next: CatalogSession | undefined;
  for (const h of held) {
    if (h.endMin <= session.startMin) {
      if (!previous || h.endMin > previous.endMin) previous = h;
    } else if (!next || h.startMin < next.startMin) {
      next = h;
    }
  }
  if (previous && !connects(ctx, previous, session)) return false;
  if (next && !connects(ctx, session, next)) return false;
  return true;
}
