import { describe, expect, it } from 'vitest';
import { session } from '../test/catalog-builders';
import { catalogHash, catalogSnapshotSchema, indexSessions } from './catalog';

describe('catalogHash', () => {
  const a = session({ sessionId: 'a', room: 'Hall 1' });
  const b = session({ sessionId: 'b', startMin: 28_000_120, endMin: 28_000_180, venue: 'wynn' });

  it('has the manifest format', () => {
    expect(catalogHash([a, b])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not depend on the order of the sessions', () => {
    expect(catalogHash([a, b])).toBe(catalogHash([b, a]));
  });

  it.each([
    ['start', { startMin: a.startMin + 5 }],
    ['end', { endMin: a.endMin + 5 }],
    ['venue', { venue: 'wynn' }],
    ['room', { room: 'Hall 2' }],
  ])('changes when the %s changes', (_name, change) => {
    expect(catalogHash([{ ...a, ...change }, b])).not.toBe(catalogHash([a, b]));
  });

  it('ignores fields that do not affect scheduling (title, level, features)', () => {
    const edited = { ...a, title: 'A new title', level: '400', features: ['x'] };
    expect(catalogHash([edited, b])).toBe(catalogHash([a, b]));
  });

  it('treats a missing room and an empty room the same', () => {
    expect(catalogHash([{ ...a, room: undefined }])).toBe(catalogHash([{ ...a, room: '' }]));
  });

  it('is stable (golden value, computed independently with Node crypto)', () => {
    // sha256 of the text [["s1",1,2,"v","r"]]. An accidental format change breaks this on purpose.
    expect(
      catalogHash([session({ sessionId: 's1', startMin: 1, endMin: 2, venue: 'v', room: 'r' })]),
    ).toBe('sha256:c01c7e48d037a6e658ffa69d4cc0153c6baf79b84c3c8d8ed359395de061c65a');
  });
});

describe('indexSessions', () => {
  it('indexes by id and keeps the first of a duplicate', () => {
    const first = session({ sessionId: 'a', title: 'first' });
    const second = session({ sessionId: 'a', title: 'second' });
    expect(indexSessions([first, second]).get('a')?.title).toBe('first');
  });
});

describe('catalogSnapshotSchema', () => {
  it('rejects extra fields so unknown catalog data cannot slip into fixtures', () => {
    const snapshot = {
      eventId: 'e',
      utcOffsetMin: -480,
      sessions: [{ ...session({ sessionId: 'a' }), abstract: 'x' }],
    };
    expect(catalogSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(
      catalogSnapshotSchema.safeParse({ ...snapshot, sessions: [session({ sessionId: 'a' })] })
        .success,
    ).toBe(true);
  });
});
