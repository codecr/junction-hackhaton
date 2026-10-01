import { z } from 'zod';
import { sha256Hex, compareStrings } from './bytes';
import { canonicalJson } from './canonical';
import { sessionCodeSchema, sessionIdSchema } from './schemas';

// The agent maps Events API responses (every field optional) into this normalised shape and drops
// sessions it cannot place in time. Core only ever sees sessions with an id, code, time and venue.
// Field names for type, level and features follow docs/04 and stay provisional until Spike 0.

export const catalogSessionSchema = z.strictObject({
  sessionId: sessionIdSchema,
  code: sessionCodeSchema,
  title: z.string().max(300),
  type: z.string().optional(),
  level: z.string().optional(),
  features: z.array(z.string()).optional(),
  speakers: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  tracks: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  /** Epoch minutes, UTC. */
  startMin: z.int(),
  endMin: z.int(),
  /** Normalised venue id (see venues.ts). */
  venue: z.string().min(1),
  room: z.string().optional(),
  full: z.boolean().optional(),
});

export const catalogSnapshotSchema = z.strictObject({
  eventId: z.string().min(1),
  /** Event-local UTC offset in minutes, fixed for the event week (Las Vegas in December: -480). */
  utcOffsetMin: z.int(),
  sessions: z.array(catalogSessionSchema),
});

export type CatalogSession = z.infer<typeof catalogSessionSchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;

/** sha256 over the sorted (sessionId, start, end, venue, room) list. Included in every manifest. */
export function catalogHash(sessions: readonly CatalogSession[]): string {
  const rows = sessions
    .map((s) => [s.sessionId, s.startMin, s.endMin, s.venue, s.room ?? ''] as const)
    .sort((a, b) => compareStrings(a[0], b[0]));
  return `sha256:${sha256Hex(canonicalJson(rows))}`;
}

/** Index by session id. Later duplicates do not overwrite earlier ones. */
export function indexSessions(sessions: readonly CatalogSession[]): Map<string, CatalogSession> {
  const map = new Map<string, CatalogSession>();
  for (const s of sessions) if (!map.has(s.sessionId)) map.set(s.sessionId, s);
  return map;
}
