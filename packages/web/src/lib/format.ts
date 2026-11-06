import type { ViewDay } from '@junction/core';

// Explicit English formatting. No Intl and no toLocale*: the same squad reads the same on every
// machine, whatever its locale.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 615 -> "10:15 AM". Minutes of the event-local day. */
export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${ap}`;
}

/** 600 -> "10 AM". For axis labels on the hour. */
export function hourLabel(min: number): string {
  const h = Math.floor((((min % 1440) + 1440) % 1440) / 60);
  return `${((h + 11) % 12) + 1} ${h >= 12 ? 'PM' : 'AM'}`;
}

export const clockRange = (a: number, b: number): string => `${clock(a)} to ${clock(b)}`;

export const weekdayName = (d: ViewDay): string => WEEKDAYS[d.weekday] ?? '';
export const weekdayShort = (d: ViewDay): string => weekdayName(d).slice(0, 3);
/** "Tuesday, 1 December" */
export const longDay = (d: ViewDay): string => `${weekdayName(d)}, ${d.d} ${MONTHS[d.m - 1] ?? ''}`;
/** "Tue 1" */
export const tabDay = (d: ViewDay): string => `${weekdayShort(d)} ${d.d}`;

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** "Ana", "Ana and Luis", "Ana, Luis and Marta" */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Milli-units to a short signed figure: 500 -> "0.50". */
export const units = (milli: number): string => (Math.abs(milli) / 1000).toFixed(2);

/** "2 minutes ago" from two instants, for the sync status. */
export function ago(iso: string, nowMs: number): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${plural(m, 'minute', 'minutes')} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${plural(h, 'hour', 'hours')} ago`;
  return `${plural(Math.round(h / 24), 'day', 'days')} ago`;
}
