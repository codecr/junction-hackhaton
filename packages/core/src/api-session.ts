import { z } from 'zod';
import { catalogSessionSchema, type CatalogSession } from './catalog';
import { SESSION_CODE_PATTERN } from './schemas';
import { err, ok, type Result } from './result';
import { daysFromCivil, parseInstant } from './time';
import { normalizeVenue, type VenueGraph } from './venues';

// Shapes follow the official OpenAPI (https://api.awsevents.com/v1/openapi.json, read 2026-10-01):
// Session requires only sessionId and title, every other field may be missing, and unknown fields
// must not break parsing. Session times are local: sessionTime.date, .time and .length (minutes).
// Which fields Spike 0 finds actually populated is still open.

const strings = z.array(z.string()).optional();

export const apiSessionSchema = z.looseObject({
  sessionId: z.string().min(1).max(128),
  title: z.string().optional(),
  abbreviation: z.string().optional(),
  type: z.string().optional(),
  level: z.string().optional(),
  venue: z.string().optional(),
  room: z.string().optional(),
  isAllDaySession: z.boolean().optional(),
  isReservable: z.boolean().optional(),
  seatAvailability: z.string().optional(),
  sessionTime: z
    .looseObject({
      date: z.string().optional(),
      time: z.string().optional(),
      length: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  speakers: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  tracks: strings,
  topics: strings,
  services: strings,
  features: strings,
});

export type ApiSession = z.infer<typeof apiSessionSchema>;

export type SkipCode =
  'invalid' | 'no-code' | 'bad-code' | 'all-day' | 'no-time' | 'no-venue' | 'unknown-venue';

export interface SkipReason {
  code: SkipCode;
  /** Session id when it could be read, plus the offending value where useful. */
  sessionId: string | undefined;
  detail: string;
}

export interface ApiSessionContext {
  /** Event-local UTC offset in minutes (Las Vegas in December: -480). */
  utcOffsetMin: number;
  venueGraph: VenueGraph;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

function localToEpochMin(date: string, time: string, offset: number): number | undefined {
  const clock = CLOCK.exec(time);
  if (!DATE.test(date) || !clock) return undefined;
  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  if (hours > 23 || minutes > 59) return undefined;
  if (parseInstant(`${date}T00:00:00Z`) === undefined) return undefined;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return daysFromCivil(y, m, d) * 1440 + hours * 60 + minutes - offset;
}

/**
 * Normalises one Events API session for core. Sessions that cannot be placed in time and space are
 * skipped with a reason rather than guessed at, so the UI can say what was dropped.
 */
export function toCatalogSession(
  raw: unknown,
  ctx: ApiSessionContext,
): Result<CatalogSession, SkipReason> {
  const parsed = apiSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const id =
      typeof raw === 'object' && raw !== null && 'sessionId' in raw
        ? String(raw.sessionId)
        : undefined;
    return err({ code: 'invalid', sessionId: id, detail: 'not a session object with an id' });
  }
  const s = parsed.data;
  const skip = (code: SkipCode, detail: string) => err({ code, sessionId: s.sessionId, detail });

  const code = s.abbreviation?.trim();
  if (!code) return skip('no-code', 'the session has no short code');
  if (!SESSION_CODE_PATTERN.test(code)) return skip('bad-code', code);
  if (s.isAllDaySession) return skip('all-day', 'all-day sessions are not placed on the chart');

  const t = s.sessionTime;
  const length = t?.length !== undefined && /^\d+$/.test(t.length) ? Number(t.length) : undefined;
  const startMin =
    t?.date !== undefined && t.time !== undefined
      ? localToEpochMin(t.date, t.time, ctx.utcOffsetMin)
      : undefined;
  if (startMin === undefined || length === undefined || length < 1 || length > 1440) {
    return skip('no-time', 'date, time and length are needed to place the session');
  }

  if (!s.venue?.trim()) return skip('no-venue', 'the session has no venue');
  const venue = normalizeVenue(s.venue, ctx.venueGraph);
  if (!venue) return skip('unknown-venue', s.venue);

  const session: CatalogSession = {
    sessionId: s.sessionId,
    code,
    title: (s.title ?? '').slice(0, 300),
    startMin,
    endMin: startMin + length,
    venue,
    ...(s.type !== undefined && { type: s.type }),
    ...(s.level !== undefined && { level: s.level }),
    ...(s.features !== undefined && { features: s.features }),
    ...(s.speakers !== undefined && {
      speakers: s.speakers.flatMap((sp) => (sp.name ? [sp.name] : [])),
    }),
    ...(s.topics !== undefined && { topics: s.topics }),
    ...(s.tracks !== undefined && { tracks: s.tracks }),
    ...(s.services !== undefined && { services: s.services }),
    ...(s.room !== undefined && { room: s.room }),
    ...(s.seatAvailability !== undefined && { full: s.seatAvailability === 'unavailable' }),
  };
  const checked = catalogSessionSchema.safeParse(session);
  return checked.success
    ? ok(checked.data)
    : skip('invalid', 'normalised session failed validation');
}

/** Maps a whole page or catalog. Returns the usable sessions and every skip, never throwing. */
export function toCatalogSessions(
  raws: readonly unknown[],
  ctx: ApiSessionContext,
): { sessions: CatalogSession[]; skipped: SkipReason[] } {
  const sessions: CatalogSession[] = [];
  const skipped: SkipReason[] = [];
  for (const raw of raws) {
    const result = toCatalogSession(raw, ctx);
    if (result.ok) sessions.push(result.value);
    else skipped.push(result.error);
  }
  return { sessions, skipped };
}
