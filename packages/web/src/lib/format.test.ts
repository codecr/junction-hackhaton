import { describe, expect, it } from 'vitest';
import { ago, clock, clockRange, hourLabel, longDay, nameList, plural, tabDay, units } from './format';

const tue = { day: 20788, y: 2026, m: 12, d: 1, weekday: 2, issues: 4 };

describe('format', () => {
  it('formats clock times in 12-hour English', () => {
    expect(clock(0)).toBe('12:00 AM');
    expect(clock(630)).toBe('10:30 AM');
    expect(clock(720)).toBe('12:00 PM');
    expect(clock(975)).toBe('4:15 PM');
    expect(clockRange(540, 600)).toBe('9:00 AM to 10:00 AM');
    expect(hourLabel(480)).toBe('8 AM');
    expect(hourLabel(1140)).toBe('7 PM');
  });

  it('names days the way the reference does', () => {
    expect(longDay(tue)).toBe('Tuesday, 1 December');
    expect(tabDay(tue)).toBe('Tue 1');
  });

  it('joins names and counts in plain English', () => {
    expect(nameList([])).toBe('');
    expect(nameList(['Ana'])).toBe('Ana');
    expect(nameList(['Ana', 'Luis'])).toBe('Ana and Luis');
    expect(nameList(['Ana', 'Luis', 'Marta'])).toBe('Ana, Luis and Marta');
    expect(plural(1, 'issue', 'issues')).toBe('1 issue');
    expect(plural(4, 'issue', 'issues')).toBe('4 issues');
    expect(units(-420)).toBe('0.42');
  });

  it('says how long ago the last sync was', () => {
    const now = Date.parse('2026-12-01T18:00:00Z');
    expect(ago('2026-12-01T17:59:50Z', now)).toBe('just now');
    expect(ago('2026-12-01T17:58:00Z', now)).toBe('2 minutes ago');
    expect(ago('2026-12-01T15:00:00Z', now)).toBe('3 hours ago');
    expect(ago('not a date', now)).toBeUndefined();
  });
});
