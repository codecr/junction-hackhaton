import { describe, expect, it } from 'vitest';
import { CHART, chartLayout, hopGeometry, laneOffset, pillWidth, timeRange } from './layout';

const venues = [
  { id: 'wynn', name: 'Wynn', at: 0 },
  { id: 'venetian', name: 'Venetian', at: 14 },
  { id: 'caesars-forum', name: 'Caesars Forum', at: 36 },
  { id: 'mgm-grand', name: 'MGM Grand', at: 66 },
  { id: 'mandalay-bay', name: 'Mandalay Bay', at: 94 },
];

describe('timeRange', () => {
  it('defaults to 8 AM to 7 PM', () => {
    expect(timeRange([])).toEqual({ start: 480, end: 1140 });
  });
  it('widens to whole hours that hold every session', () => {
    expect(timeRange([{ startLocal: 7 * 60 + 30, endLocal: 20 * 60 + 15 }])).toEqual({
      start: 420,
      end: 21 * 60,
    });
  });
  it('never leaves the day', () => {
    expect(timeRange([{ startLocal: 10, endLocal: 1439 }])).toEqual({ start: 0, end: 1440 });
  });
});

describe('laneOffset', () => {
  it('centres five lanes 9 px apart on the venue line', () => {
    expect([0, 1, 2, 3, 4].map((i) => laneOffset(i, 5))).toEqual([-18, -9, 0, 9, 18]);
  });
  it('centres an even count between lines', () => {
    expect([0, 1].map((i) => laneOffset(i, 2))).toEqual([-4.5, 4.5]);
  });
});

describe('chartLayout', () => {
  const layout = chartLayout(venues, { start: 480, end: 1140 });

  it('maps the time range onto the plot width', () => {
    expect(layout.x(480)).toBe(CHART.marginLeft);
    expect(layout.x(1140)).toBe(CHART.width - CHART.marginRight);
    const perMin = (CHART.width - CHART.marginLeft - CHART.marginRight) / 660;
    expect(layout.x(600) - layout.x(540)).toBeCloseTo(perMin * 60, 6);
  });

  it('spaces venues by walking minutes, so every walk has the same slope', () => {
    expect(layout.yVenue('wynn')).toBe(CHART.top);
    expect(layout.yVenue('mandalay-bay')).toBeCloseTo(CHART.top + 94 * CHART.kY, 6);
    const gap = (a: string, b: string) => (layout.yVenue(b) ?? 0) - (layout.yVenue(a) ?? 0);
    expect(gap('wynn', 'venetian') / 14).toBeCloseTo(gap('mgm-grand', 'mandalay-bay') / 28, 6);
    expect(layout.yVenue('nowhere')).toBeUndefined();
  });

  it('prints walking minutes halfway between neighbours', () => {
    const [wynn, venetian] = layout.venues;
    expect(wynn?.next?.minutes).toBe(14);
    expect(wynn?.next?.y).toBeCloseTo(((wynn?.y ?? 0) + (venetian?.y ?? 0)) / 2, 6);
    expect(layout.venues.at(-1)?.next).toBeUndefined();
  });

  it('has an hourly grid and room below the last venue', () => {
    expect(layout.hours).toHaveLength(12);
    expect(layout.hours[0]).toBe(480);
    expect(layout.bottom).toBeCloseTo(CHART.top + 94 * CHART.kY + CHART.bottomPad, 6);
    expect(layout.height).toBeGreaterThan(layout.bottom);
  });

  it('measures venue positions from the first venue', () => {
    const shifted = chartLayout(
      venues.map((v) => ({ ...v, at: v.at + 100 })),
      { start: 480, end: 1140 },
    );
    expect(shifted.yVenue('wynn')).toBe(CHART.top);
  });
});

describe('hopGeometry', () => {
  it('draws a slope that takes the walking time, then a flat wait', () => {
    const g = hopGeometry({ fromEnd: 600, fromY: 100, toStart: 660, toY: 200, walkMin: 22 });
    expect(g).toEqual({
      kind: 'walk',
      segments: [
        [
          { t: 600, y: 100 },
          { t: 622, y: 200 },
        ],
        [
          { t: 622, y: 200 },
          { t: 660, y: 200 },
        ],
      ],
    });
  });

  it('has no wait when the walk uses all the time', () => {
    const g = hopGeometry({ fromEnd: 600, fromY: 100, toStart: 622, toY: 200, walkMin: 22 });
    expect(g.kind === 'walk' && g.segments).toHaveLength(1);
  });

  it('stays flat within one venue', () => {
    const g = hopGeometry({ fromEnd: 600, fromY: 100, toStart: 630, toY: 100, walkMin: 0 });
    expect(g).toEqual({
      kind: 'walk',
      segments: [
        [
          { t: 600, y: 100 },
          { t: 630, y: 100 },
        ],
      ],
    });
  });

  it('stops an impossible walk short in proportion to the time available', () => {
    // Luis: 28 min needed, 15 min available, MGM Grand to Mandalay Bay.
    const g = hopGeometry({
      fromEnd: 840,
      fromY: 300,
      toStart: 855,
      toY: 386.8,
      walkMin: 28,
      impossible: { needMin: 28, haveMin: 15 },
    });
    expect(g.kind).toBe('cant');
    if (g.kind !== 'cant') return;
    expect(g.end.t).toBe(855);
    expect(g.end.y).toBeCloseTo(300 + 86.8 * (15 / 28), 6);
    expect(g.line[0]).toEqual({ t: 840, y: 300 });
    expect([g.needMin, g.haveMin]).toEqual([28, 15]);
  });

  it('treats a walk longer than the gap as impossible even without a report', () => {
    const g = hopGeometry({ fromEnd: 600, fromY: 0, toStart: 610, toY: 100, walkMin: 30 });
    expect(g.kind).toBe('cant');
  });

  it('does not travel at all when sessions overlap', () => {
    const g = hopGeometry({
      fromEnd: 600,
      fromY: 0,
      toStart: 590,
      toY: 100,
      walkMin: 30,
      impossible: { needMin: 30, haveMin: -10 },
    });
    expect(g.kind === 'cant' && g.end.y).toBe(0);
  });
});

describe('pillWidth', () => {
  it('grows with the label and pads both sides', () => {
    expect(pillWidth('Duplicate')).toBeLessThan(pillWidth('Planned overlap'));
    expect(pillWidth('')).toBe(14);
  });
});
