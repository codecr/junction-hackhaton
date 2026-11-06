import { DatabaseSync } from 'node:sqlite';
import {
  catalogHash,
  defaultVenueGraph,
  toCatalogSessions,
  type CatalogSession,
  type CatalogSnapshot,
  type SkipReason,
  type VenueGraph,
} from '@junction/core';
import { ensureDir, paths, junctionHome } from './paths';

// The attendee's own copy of the catalog, in ~/.junction/catalog.db. It never leaves this machine
// and is never committed (CLAUDE.md rule 3). Raw API sessions are stored as returned; core sees the
// normalised snapshot.

export interface CatalogMeta {
  eventId: string;
  timezone: string;
  utcOffsetMin: number;
  fetchedAt: string;
  totalCount: number | undefined;
  pages: number;
}

export interface CatalogDiff {
  added: string[];
  removed: string[];
  changed: { sessionId: string; fields: string[] }[];
}

export interface CatalogStore {
  saveRaw(meta: CatalogMeta, raws: readonly Record<string, unknown>[]): CatalogDiff;
  meta(): CatalogMeta | undefined;
  raw(sessionId: string): Record<string, unknown> | undefined;
  allRaw(): Record<string, unknown>[];
  snapshot(
    graph?: VenueGraph,
  ): { snapshot: CatalogSnapshot; skipped: SkipReason[]; hash: string } | undefined;
  firstSeen(): Record<string, string>;
  close(): void;
}

const WATCHED = [
  'title',
  'sessionTime',
  'venue',
  'room',
  'seatAvailability',
  'abbreviation',
] as const;

/** Event-local UTC offset in minutes at an instant, from the IANA zone (agent only; core never uses Intl). */
export function utcOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? '0'));
}

export class SqliteCatalogStore implements CatalogStore {
  private readonly db: DatabaseSync;

  constructor(file = paths.catalogDb()) {
    ensureDir(junctionHome());
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, json TEXT NOT NULL, first_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  saveRaw(meta: CatalogMeta, raws: readonly Record<string, unknown>[]): CatalogDiff {
    const before = new Map(this.allRaw().map((r) => [String(r.sessionId), r]));
    const seen = new Map(
      (
        this.db.prepare('SELECT session_id, first_seen FROM sessions').all() as {
          session_id: string;
          first_seen: string;
        }[]
      ).map((r) => [r.session_id, r.first_seen]),
    );
    const diff: CatalogDiff = { added: [], removed: [], changed: [] };
    const after = new Set<string>();
    for (const raw of raws) {
      const id = String(raw.sessionId);
      after.add(id);
      const prev = before.get(id);
      if (!prev) {
        if (before.size > 0) diff.added.push(id);
        continue;
      }
      const fields = WATCHED.filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(raw[f]));
      if (fields.length > 0) diff.changed.push({ sessionId: id, fields: [...fields] });
    }
    for (const id of before.keys()) if (!after.has(id)) diff.removed.push(id);

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM sessions');
      const insert = this.db.prepare(
        'INSERT INTO sessions (session_id, json, first_seen) VALUES (?, ?, ?)',
      );
      for (const raw of raws) {
        const id = String(raw.sessionId);
        insert.run(id, JSON.stringify(raw), seen.get(id) ?? meta.fetchedAt);
      }
      this.db
        .prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
        .run('meta', JSON.stringify(meta));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return diff;
  }

  meta(): CatalogMeta | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('meta') as
      { v: string } | undefined;
    return row ? (JSON.parse(row.v) as CatalogMeta) : undefined;
  }

  raw(sessionId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT json FROM sessions WHERE session_id = ?').get(sessionId) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Record<string, unknown>) : undefined;
  }

  allRaw(): Record<string, unknown>[] {
    return (
      this.db.prepare('SELECT json FROM sessions ORDER BY session_id').all() as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Record<string, unknown>);
  }

  firstSeen(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT session_id, first_seen FROM sessions').all() as {
      session_id: string;
      first_seen: string;
    }[]) {
      out[r.session_id] = r.first_seen;
    }
    return out;
  }

  snapshot(graph: VenueGraph = defaultVenueGraph) {
    const meta = this.meta();
    if (!meta) return undefined;
    const { sessions, skipped } = toCatalogSessions(this.allRaw(), {
      utcOffsetMin: meta.utcOffsetMin,
      venueGraph: graph,
    });
    const snapshot: CatalogSnapshot = {
      eventId: meta.eventId,
      utcOffsetMin: meta.utcOffsetMin,
      sessions,
    };
    return { snapshot, skipped, hash: catalogHash(sessions) };
  }

  close(): void {
    this.db.close();
  }
}

/** Counts used by `junction catalog stats` and Spike 0. Labels are printed locally only. */
export function catalogStats(
  raws: readonly Record<string, unknown>[],
  sessions: readonly CatalogSession[],
  skipped: readonly SkipReason[],
) {
  const count = (field: string) => {
    const m = new Map<string, number>();
    for (const r of raws) {
      const v = r[field];
      const values = Array.isArray(v) ? v : v === undefined ? [] : [v];
      for (const x of values) {
        const key = typeof x === 'string' ? x : JSON.stringify(x);
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const fieldPresence = new Map<string, number>();
  for (const r of raws)
    for (const k of Object.keys(r)) fieldPresence.set(k, (fieldPresence.get(k) ?? 0) + 1);
  const suffixes = new Map<string, number>();
  for (const r of raws) {
    const code = typeof r.abbreviation === 'string' ? r.abbreviation : '';
    const m = /-([A-Z]+\d*)$/.exec(code);
    const key = m ? m[1]!.replace(/\d+$/, 'n') : '(none)';
    suffixes.set(key, (suffixes.get(key) ?? 0) + 1);
  }
  const skippedBy = new Map<string, number>();
  for (const s of skipped) skippedBy.set(s.code, (skippedBy.get(s.code) ?? 0) + 1);
  return {
    total: raws.length,
    usable: sessions.length,
    skipped: [...skippedBy.entries()],
    fields: [...fieldPresence.entries()].sort((a, b) => b[1] - a[1]),
    venues: count('venue'),
    types: count('type'),
    levels: count('level'),
    topics: count('topics'),
    tracks: count('tracks'),
    services: count('services').slice(0, 40),
    features: count('features'),
    seatAvailability: count('seatAvailability'),
    suffixes: [...suffixes.entries()].sort((a, b) => b[1] - a[1]),
  };
}
