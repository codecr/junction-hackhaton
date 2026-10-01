import { describe, expect, it } from 'vitest';
import {
  daysFromCivil,
  civilFromDays,
  formatDay,
  formatInstant,
  localDay,
  localMinuteOfDay,
  parseClock,
  parseInstant,
  parseInstantMinutes,
} from './time';

describe('parseInstant', () => {
  // Reference values computed independently with Node's Date.
  it.each([
    ['1970-01-01T00:00:00Z', 0],
    ['1969-12-31T23:59:59Z', -1],
    ['2000-02-29T12:34:56Z', 951827696],
    ['2026-12-01T00:00:00Z', 1796083200],
    ['2100-03-01T00:00:00Z', 4107542400],
  ])('parses %s', (iso, epoch) => {
    expect(parseInstant(iso)).toBe(epoch);
  });

  it('drops fractional seconds', () => {
    expect(parseInstant('2026-12-01T00:00:00.999Z')).toBe(1796083200);
  });

  it.each([
    '2026-12-01',
    '2026-12-01T00:00:00',
    '2026-12-01T00:00:00+01:00',
    '2026-13-01T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2026-12-01T24:00:00Z',
    '2026-12-01T00:60:00Z',
    'not a date',
  ])('rejects %s', (iso) => {
    expect(parseInstant(iso)).toBeUndefined();
  });

  it('accepts a real leap day', () => {
    expect(parseInstant('2024-02-29T00:00:00Z')).toBeDefined();
    expect(parseInstant('2000-02-29T00:00:00Z')).toBeDefined();
  });
});

describe('format and civil conversions', () => {
  it('round-trips instants across a wide range', () => {
    for (let sec = -2_000_000_000; sec < 4_200_000_000; sec += 123_456_789) {
      expect(parseInstant(formatInstant(sec))).toBe(sec);
    }
  });

  it('round-trips days', () => {
    for (let day = -800_000; day < 800_000; day += 977) {
      const { y, m, d } = civilFromDays(day);
      expect(daysFromCivil(y, m, d)).toBe(day);
    }
  });

  it('formats a known instant', () => {
    expect(formatInstant(1796140800)).toBe('2026-12-01T16:00:00Z');
  });

  it('returns whole minutes', () => {
    expect(parseInstantMinutes('2026-12-01T16:00:59Z')).toBe(1796140800 / 60);
    expect(parseInstantMinutes('bad')).toBeUndefined();
  });
});

describe('event-local time with a fixed offset', () => {
  const PST = -480;
  const nineAm = parseInstantMinutes('2026-12-01T17:00:00Z')!; // 09:00 PST on 1 December

  it('derives the local day and minute of day', () => {
    expect(formatDay(localDay(nineAm, PST))).toBe('2026-12-01');
    expect(localMinuteOfDay(nineAm, PST)).toBe(9 * 60);
  });

  it('puts 11 PM PST on the same local day even though UTC has rolled over', () => {
    const lateEvening = parseInstantMinutes('2026-12-02T07:00:00Z')!; // 23:00 PST on 1 December
    expect(formatDay(localDay(lateEvening, PST))).toBe('2026-12-01');
    expect(localMinuteOfDay(lateEvening, PST)).toBe(23 * 60);
  });
});

describe('parseClock', () => {
  it('parses valid clocks', () => {
    expect(parseClock('12:30')).toBe(750);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('23:59')).toBe(1439);
  });
  it('rejects invalid clocks', () => {
    expect(parseClock('24:00')).toBeUndefined();
    expect(parseClock('9:00')).toBeUndefined();
    expect(parseClock('12:60')).toBeUndefined();
  });
});
