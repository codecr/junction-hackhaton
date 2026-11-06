import { scaleLinear } from 'd3-scale';

// Geometry of the Marey chart, kept pure so it can be tested without a DOM. Time runs along x,
// venues along y spaced by walking minutes, so every walk has the same slope.

export const CHART = {
  width: 1120,
  marginLeft: 138,
  marginRight: 24,
  /** y of the first venue line. */
  top: 92,
  /** Pixels per walking minute between venues. */
  kY: 4,
  /** Minimum distance between venue lines, enough for five lanes. */
  minRowGap: 40,
  /** Vertical distance between member lanes. */
  laneGap: 9,
  /** Space below the last venue. */
  bottomPad: 34,
  /** Top of the gridlines and lunch band. */
  gridTop: 44,
} as const;

export type ChartConfig = typeof CHART;

export interface TimeRange {
  start: number;
  end: number;
}

/** Whole hours that hold every span, never narrower than 8 AM to 7 PM. */
export function timeRange(
  spans: readonly { startLocal: number; endLocal: number }[],
  min: TimeRange = { start: 8 * 60, end: 19 * 60 },
): TimeRange {
  let start = min.start;
  let end = min.end;
  for (const s of spans) {
    start = Math.min(start, Math.floor(s.startLocal / 60) * 60);
    end = Math.max(end, Math.ceil(s.endLocal / 60) * 60);
  }
  return { start: Math.max(0, start), end: Math.min(24 * 60, end) };
}

/** Lanes centred on the venue line: five members sit at -18, -9, 0, 9, 18. */
export function laneOffset(index: number, count: number, gap: number = CHART.laneGap): number {
  return (index - (count - 1) / 2) * gap;
}

export interface VenueRow {
  id: string;
  name: string;
  y: number;
  /** Walking minutes to the next venue down, and where to print it. */
  next?: { minutes: number; y: number };
}

export interface ChartLayout {
  width: number;
  height: number;
  bottom: number;
  range: TimeRange;
  x: (min: number) => number;
  /** y of a venue line, or undefined for a venue the chart does not know. */
  yVenue: (id: string) => number | undefined;
  venues: VenueRow[];
  hours: number[];
}

export function chartLayout(
  venues: readonly { id: string; name: string; at: number }[],
  range: TimeRange,
  cfg: ChartConfig = CHART,
): ChartLayout {
  const x = scaleLinear()
    .domain([range.start, range.end])
    .range([cfg.marginLeft, cfg.width - cfg.marginRight]);
  // Rows follow walking minutes, but never sit closer than `minRowGap`, so two venues next door
  // (Caesars Forum and Caesars Palace are 6 minutes apart) keep their lanes and labels apart.
  const ys = new Map<string, number>();
  let prev: { at: number; y: number } | undefined;
  for (const v of venues) {
    const y = prev ? prev.y + Math.max(cfg.minRowGap, (v.at - prev.at) * cfg.kY) : cfg.top;
    ys.set(v.id, y);
    prev = { at: v.at, y };
  }
  const rows: VenueRow[] = venues.map((v, i) => {
    const y = ys.get(v.id) ?? cfg.top;
    const after = venues[i + 1];
    if (!after) return { id: v.id, name: v.name, y };
    const yNext = ys.get(after.id) ?? y;
    return {
      id: v.id,
      name: v.name,
      y,
      next: { minutes: Math.abs(after.at - v.at), y: (y + yNext) / 2 },
    };
  });
  const lastY = rows.length > 0 ? Math.max(...rows.map((r) => r.y)) : cfg.top;
  const bottom = lastY + cfg.bottomPad;
  const hours: number[] = [];
  for (let m = Math.ceil(range.start / 60) * 60; m <= range.end; m += 60) hours.push(m);
  return {
    width: cfg.width,
    height: bottom + 6,
    bottom,
    range,
    x: (min: number) => x(min),
    yVenue: (id: string) => ys.get(id),
    venues: rows,
    hours,
  };
}

/** A point in (minute of day, y pixel) space. */
export interface Pt {
  t: number;
  y: number;
}

export type HopGeometry =
  | { kind: 'walk'; segments: [Pt, Pt][] }
  | { kind: 'cant'; line: [Pt, Pt]; end: Pt; needMin: number; haveMin: number };

/**
 * How a person gets from one session to the next. A walk is a slope that takes `walkMin` minutes,
 * then a flat wait if they arrive early. When the walk (plus the squad's buffer) does not fit, the
 * line stops short in proportion to the time they have, which is where the chart draws the cross.
 */
export function hopGeometry(input: {
  fromEnd: number;
  fromY: number;
  toStart: number;
  toY: number;
  walkMin: number;
  /** From the coverage report when the hop is impossible (needMin includes the buffer). */
  impossible?: { needMin: number; haveMin: number };
}): HopGeometry {
  const { fromEnd, fromY, toStart, toY, walkMin } = input;
  const haveMin = toStart - fromEnd;
  const impossible =
    input.impossible ?? (walkMin > haveMin ? { needMin: walkMin, haveMin } : undefined);
  if (impossible) {
    const f =
      impossible.needMin > 0
        ? Math.max(0, Math.min(1, impossible.haveMin / impossible.needMin))
        : 0;
    const end = { t: toStart, y: fromY + (toY - fromY) * f };
    return {
      kind: 'cant',
      line: [{ t: fromEnd, y: fromY }, end],
      end,
      needMin: impossible.needMin,
      haveMin: impossible.haveMin,
    };
  }
  if (walkMin === 0 || fromY === toY)
    return {
      kind: 'walk',
      segments: [
        [
          { t: fromEnd, y: fromY },
          { t: toStart, y: toY },
        ],
      ],
    };
  const arrive = { t: fromEnd + walkMin, y: toY };
  const segments: [Pt, Pt][] = [[{ t: fromEnd, y: fromY }, arrive]];
  if (haveMin > walkMin) segments.push([arrive, { t: toStart, y: toY }]);
  return { kind: 'walk', segments };
}

/** Width of a pill label in the chart's semi-condensed 11.5 px type, measured once and fixed. */
export function pillWidth(label: string): number {
  return Math.round(label.length * 6.1 + 14);
}
