// Time without Date or Intl (CLAUDE.md rule 10). Instants are integer seconds or minutes since the
// Unix epoch, UTC. Event-local days use a fixed UTC offset passed by the caller, so no tz database.

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Parses `YYYY-MM-DDTHH:mm:ss[.fff]Z` to epoch seconds. Fractions are dropped. Undefined if invalid. */
export function parseInstant(iso: string): number | undefined {
  const match = ISO_UTC.exec(iso);
  if (!match) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Formats epoch seconds as `YYYY-MM-DDTHH:mm:ssZ`. */
export function formatInstant(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const rest = epochSec - days * 86400;
  const { y, m, d } = civilFromDays(days);
  const h = Math.floor(rest / 3600);
  const mi = Math.floor((rest - h * 3600) / 60);
  const s = rest - h * 3600 - mi * 60;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}Z`;
}

/** Epoch minutes (floor) for an ISO instant. */
export function parseInstantMinutes(iso: string): number | undefined {
  const sec = parseInstant(iso);
  return sec === undefined ? undefined : Math.floor(sec / 60);
}

/** Event-local day number (days since epoch in local time) for an epoch-minute instant. */
export function localDay(epochMin: number, utcOffsetMin: number): number {
  return Math.floor((epochMin + utcOffsetMin) / 1440);
}

/** Minutes after local midnight, 0 to 1439. */
export function localMinuteOfDay(epochMin: number, utcOffsetMin: number): number {
  const shifted = epochMin + utcOffsetMin;
  return shifted - Math.floor(shifted / 1440) * 1440;
}

/** `HH:mm` to minutes after midnight. Undefined if invalid. */
export function parseClock(hhmm: string): number | undefined {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** Local day number to `YYYY-MM-DD`. */
export function formatDay(day: number): string {
  const { y, m, d } = civilFromDays(day);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}
