import { describe, expect, it } from 'vitest';
import { toCatalogSession, toCatalogSessions, type ApiSessionContext } from './api-session';
import { parseInstantMinutes } from './time';
import { defaultVenueGraph } from './venues';

const ctx: ApiSessionContext = { utcOffsetMin: -480, venueGraph: defaultVenueGraph };

const full = {
  sessionId: 'sess-1',
  title: 'Invented talk',
  abbreviation: 'AGT301',
  type: 'Chalk talk',
  level: '300 - Advanced',
  venue: 'Venetian',
  room: 'Level 3, Room 307',
  isAllDaySession: false,
  isReservable: true,
  seatAvailability: 'limited',
  sessionTime: { date: '2026-12-01', time: '09:00', length: '60', timezone: 'America/Los_Angeles' },
  speakers: [{ name: 'A. Speaker' }, {}],
  tracks: ['Track X'],
  topics: ['Agentic AI'],
  services: ['Service Y'],
  features: ['Interactive'],
  abstract: 'ignored',
  somethingNew: { nested: true },
};

describe('toCatalogSession', () => {
  it('normalises a full session and converts local time to UTC minutes', () => {
    const result = toCatalogSession(full, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      sessionId: 'sess-1',
      code: 'AGT301',
      title: 'Invented talk',
      type: 'Chalk talk',
      level: '300 - Advanced',
      features: ['Interactive'],
      speakers: ['A. Speaker'],
      topics: ['Agentic AI'],
      tracks: ['Track X'],
      services: ['Service Y'],
      startMin: parseInstantMinutes('2026-12-01T17:00:00Z'), // 09:00 PST
      endMin: parseInstantMinutes('2026-12-01T18:00:00Z'),
      venue: 'venetian',
      room: 'Level 3, Room 307',
      full: false,
    });
  });

  it('accepts a minimal session and an unpadded hour', () => {
    const result = toCatalogSession(
      {
        sessionId: 's',
        title: 'T',
        abbreviation: 'AGT301',
        venue: 'Wynn',
        sessionTime: { date: '2026-12-01', time: '9:30', length: '45' },
      },
      ctx,
    );
    expect(result.ok && result.value.startMin).toBe(parseInstantMinutes('2026-12-01T17:30:00Z'));
    expect(result.ok && result.value.endMin).toBe(parseInstantMinutes('2026-12-01T18:15:00Z'));
  });

  it('marks a session full only when the band is unavailable', () => {
    const band = (b: string) => toCatalogSession({ ...full, seatAvailability: b }, ctx);
    expect(band('unavailable')).toMatchObject({ ok: true, value: { full: true } });
    expect(band('veryLimited')).toMatchObject({ ok: true, value: { full: false } });
    expect(band('walkUp')).toMatchObject({ ok: true, value: { full: false } });
    const none = toCatalogSession({ ...full, seatAvailability: undefined }, ctx);
    expect(none.ok && 'full' in none.value).toBe(false);
  });

  it('keeps unknown extra fields from breaking parsing', () => {
    expect(toCatalogSession({ ...full, brandNewField: 1 }, ctx).ok).toBe(true);
  });

  it('truncates very long titles instead of dropping the session', () => {
    const result = toCatalogSession({ ...full, title: 'x'.repeat(500) }, ctx);
    expect(result.ok && result.value.title).toHaveLength(300);
  });

  it.each([
    ['no-code', { abbreviation: undefined }],
    ['no-code', { abbreviation: '   ' }],
    ['bad-code', { abbreviation: 'agt-301' }],
    ['all-day', { isAllDaySession: true }],
    ['no-time', { sessionTime: undefined }],
    ['no-time', { sessionTime: { date: '2026-12-01', time: '09:00' } }],
    ['no-time', { sessionTime: { date: '2026-12-01', time: '25:00', length: '60' } }],
    ['no-time', { sessionTime: { date: '2026-02-30', time: '09:00', length: '60' } }],
    ['no-time', { sessionTime: { date: '2026-12-01', time: '09:00', length: 'an hour' } }],
    ['no-time', { sessionTime: { date: '2026-12-01', time: '09:00', length: '0' } }],
    ['no-venue', { venue: undefined }],
    ['unknown-venue', { venue: 'Somewhere Else' }],
  ])('skips with %s', (code, change) => {
    const result = toCatalogSession({ ...full, ...change }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.error.sessionId).toBe('sess-1');
    }
  });

  it('reports the raw venue so someone can add an alias', () => {
    const result = toCatalogSession({ ...full, venue: 'Somewhere Else' }, ctx);
    expect(!result.ok && result.error.detail).toBe('Somewhere Else');
  });

  it.each([null, undefined, 42, 'x', [], {}, { sessionId: '' }, { title: 'no id' }])(
    'rejects %j as invalid',
    (raw) => {
      const result = toCatalogSession(raw, ctx);
      expect(!result.ok && result.error.code).toBe('invalid');
    },
  );

  it('keeps the id on an invalid session when it can read one', () => {
    const result = toCatalogSession({ sessionId: 'abc', title: 42 }, ctx);
    expect(!result.ok && result.error.sessionId).toBe('abc');
  });
});

describe('toCatalogSessions', () => {
  it('returns usable sessions and every skip, in order', () => {
    const { sessions, skipped } = toCatalogSessions(
      [
        full,
        { ...full, sessionId: 'b', abbreviation: undefined },
        { ...full, sessionId: 'c' },
        null,
      ],
      ctx,
    );
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-1', 'c']);
    expect(skipped.map((s) => s.code)).toEqual(['no-code', 'invalid']);
  });
});
