import { describe, expect, it } from 'vitest';
import { session } from '../test/catalog-builders';
import { testCharter, testManifest, testMember } from '../test/helpers';
import type { CatalogSnapshot } from './catalog';
import {
  analyseCoverage,
  collidesWithLunch,
  heldSessions,
  issuesOnDay,
  targetOf,
  topicIdsOf,
} from './coverage';
import type { Charter, Manifest, ManifestSession } from './schemas';
import { localDay, parseInstantMinutes } from './time';
import { defaultVenueGraph } from './venues';

const PST = -480;
const MIDNIGHT_TUE = parseInstantMinutes('2026-12-01T08:00:00Z')!; // 00:00 PST, 1 December
const DAY = 1440;
/** Epoch minutes for a local clock time on Tuesday (dayOffset 0) or later. */
const at = (h: number, m = 0, dayOffset = 0): number => MIDNIGHT_TUE + dayOffset * DAY + h * 60 + m;

const ana = testMember('Ana', 1);
const luis = testMember('Luis', 2);
const marta = testMember('Marta', 3);

const baseCharter = (overrides: Partial<Charter> = {}): Charter =>
  testCharter([ana, luis, marta], {
    topics: [
      {
        id: 'security',
        label: 'Security',
        weight: 4,
        target: 1,
        match: { topics: ['Security and compliance'] },
      },
      {
        id: 'data',
        label: 'Data',
        weight: 3,
        target: 1,
        match: { topics: ['Data and analytics'] },
      },
      {
        id: 'agentic',
        label: 'Agentic AI',
        weight: 5,
        target: 2,
        match: { topics: ['Agentic AI'], tracks: ['AI'] },
      },
    ],
    ...overrides,
  });

const catalog = (sessions: ReturnType<typeof session>[]): CatalogSnapshot => ({
  eventId: 'reinvent2026',
  utcOffsetMin: PST,
  sessions,
});

const hold = (...ids: string[]): ManifestSession[] =>
  ids.map((sessionId) => ({ sessionId, code: 'AGT301', status: 'reserved' as const }));

const manifestFor = (
  member: typeof ana,
  charter: Charter,
  sessions: ManifestSession[],
  overrides: Partial<Manifest> = {},
): Manifest => testManifest(member, charter, { sessions, ...overrides });

const opsR = session({
  sessionId: 'ops-r',
  code: 'OPS305-R',
  title: 'Guardrails for generated infrastructure',
  venue: 'venetian',
  startMin: at(10, 30),
  endMin: at(11, 30),
  topics: ['Security and compliance'],
});
const opsR1 = session({
  sessionId: 'ops-r1',
  code: 'OPS305-R1',
  title: 'Guardrails for generated infrastructure',
  venue: 'venetian',
  startMin: at(10, 30, 1),
  endMin: at(11, 30, 1),
  topics: ['Security and compliance'],
});
const dat402 = session({
  sessionId: 'dat402',
  code: 'DAT402',
  title: 'Zero-ETL at scale',
  venue: 'mgm-grand',
  startMin: at(13),
  endMin: at(14),
  topics: ['Data and analytics'],
});
const dat404 = session({
  sessionId: 'dat404',
  code: 'DAT404',
  title: 'Vector search cost tuning',
  venue: 'mandalay-bay',
  startMin: at(14, 15),
  endMin: at(15, 15),
  topics: ['Data and analytics'],
});
const sec301 = session({
  sessionId: 'sec301',
  code: 'SEC301',
  title: 'Compliance evidence, automated',
  venue: 'mgm-grand',
  startMin: at(12),
  endMin: at(13),
  topics: ['Security and compliance'],
});

const run = (
  charter: Charter,
  manifests: Manifest[],
  sessions: ReturnType<typeof session>[],
  extra = {},
) =>
  analyseCoverage({
    charter,
    manifests,
    catalog: catalog(sessions),
    venueGraph: defaultVenueGraph,
    ...extra,
  });

describe('acceptance scenario 1: duplicate', () => {
  it('flags an unplanned duplicate when two members hold OPS305-R and the target is 1', () => {
    const charter = baseCharter();
    const report = run(
      charter,
      [manifestFor(ana, charter, hold('ops-r')), manifestFor(luis, charter, hold('ops-r'))],
      [opsR, opsR1],
    );
    expect(report.duplicates).toEqual([
      {
        sessionId: 'ops-r',
        code: 'OPS305-R',
        day: localDay(at(10, 30), PST),
        attendees: [ana.memberId, luis.memberId].sort(),
        target: 1,
        planned: false,
      },
    ]);
  });

  it('calls it planned when the topic target asks for two attendees', () => {
    const charter = baseCharter({
      topics: [
        {
          id: 'security',
          label: 'Security',
          weight: 4,
          target: 2,
          match: { topics: ['Security and compliance'] },
        },
      ],
    });
    const report = run(
      charter,
      [manifestFor(ana, charter, hold('ops-r')), manifestFor(luis, charter, hold('ops-r'))],
      [opsR],
    );
    expect(report.duplicates[0]).toMatchObject({ target: 2, planned: true });
  });

  it('does not flag sessions held by one member', () => {
    const charter = baseCharter();
    const report = run(
      charter,
      [manifestFor(ana, charter, hold('ops-r')), manifestFor(luis, charter, hold('ops-r1'))],
      [opsR, opsR1],
    );
    expect(report.duplicates).toEqual([]);
  });

  it('uses the highest target when a session matches several topics, and 1 when it matches none', () => {
    const charter = baseCharter();
    const both = session({
      sessionId: 'both',
      code: 'AGT401',
      topics: ['Security and compliance'],
      tracks: ['AI'],
    });
    const none = session({ sessionId: 'none', code: 'AGT402', topics: ['Other'] });
    expect(topicIdsOf(both, charter)).toEqual(['agentic', 'security']);
    expect(targetOf(both, charter)).toBe(2);
    expect(targetOf(none, charter)).toBe(1);
  });
});

describe('acceptance scenario 2: impossible walk', () => {
  it('reports the 28 minutes needed and 15 available when Luis leaves MGM Grand at 2:00 PM for Mandalay Bay at 2:15 PM', () => {
    const charter = baseCharter();
    const report = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'dat404'))],
      [dat402, dat404],
    );
    expect(report.hops).toEqual([
      {
        memberId: luis.memberId,
        day: localDay(at(14, 15), PST),
        fromSessionId: 'dat402',
        toSessionId: 'dat404',
        needMin: 28,
        haveMin: 15,
        overlap: false,
      },
    ]);
  });

  it('adds the charter buffer to the walk', () => {
    const charter = baseCharter({ travel: { bufferMin: 5 } });
    const slack = session({ ...dat404, sessionId: 'dat404', startMin: at(14, 33) }); // 33 min gap: 28 fits, 33 needs buffer 5 → still fits
    const tight = session({ ...dat404, sessionId: 'tight', startMin: at(14, 30) }); // 30 min gap: 28 fits, 33 does not
    const ok = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'dat404'))],
      [dat402, slack],
    );
    expect(ok.hops).toEqual([]);
    const bad = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'tight'))],
      [dat402, tight],
    );
    expect(bad.hops[0]).toMatchObject({ needMin: 33, haveMin: 30 });
  });

  it('allows a walk that exactly fits the gap', () => {
    const charter = baseCharter();
    const exact = session({ ...dat404, startMin: at(14, 28) });
    expect(
      run(charter, [manifestFor(luis, charter, hold('dat402', 'dat404'))], [dat402, exact]).hops,
    ).toEqual([]);
  });

  it('flags an overlap as an impossible connection with a negative gap', () => {
    const charter = baseCharter();
    const overlapping = session({
      ...dat404,
      venue: 'mgm-grand',
      startMin: at(13, 30),
      endMin: at(14, 30),
    });
    const report = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'dat404'))],
      [dat402, overlapping],
    );
    expect(report.hops[0]).toMatchObject({ overlap: true, haveMin: -30, needMin: 0 });
  });

  it('cannot judge a hop when a venue is unknown, and says so instead of guessing', () => {
    const charter = baseCharter();
    const mystery = session({ ...dat404, venue: 'mystery-hall' });
    const report = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'dat404'))],
      [dat402, mystery],
    );
    expect(report.hops).toEqual([]);
    expect(report.unjudgedHops).toEqual([
      { memberId: luis.memberId, fromSessionId: 'dat402', toSessionId: 'dat404' },
    ]);
  });
});

describe('coverage matrix', () => {
  it('counts distinct members per topic and day, and sets the state against the target', () => {
    const charter = baseCharter({
      topics: [
        {
          id: 'data',
          label: 'Data',
          weight: 3,
          target: 2,
          match: { topics: ['Data and analytics'] },
        },
      ],
    });
    const report = run(
      charter,
      [
        manifestFor(ana, charter, hold('dat402')),
        manifestFor(luis, charter, hold('dat402', 'dat404')),
      ],
      [dat402, dat404, opsR1],
    );
    const tuesday = report.cells.find((c) => c.day === localDay(at(9), PST))!;
    expect(tuesday).toMatchObject({
      topicId: 'data',
      count: 2,
      target: 2,
      state: 'ok',
      offered: 2,
    });
    expect(tuesday.members).toEqual([ana.memberId, luis.memberId].sort());
    const wednesday = report.cells.find((c) => c.day === localDay(at(9, 0, 1), PST))!;
    expect(wednesday).toMatchObject({ count: 0, state: 'none', offered: 0 });
  });

  it('reports under target when fewer members than the target hold the topic', () => {
    const charter = baseCharter({
      topics: [
        {
          id: 'data',
          label: 'Data',
          weight: 3,
          target: 2,
          match: { topics: ['Data and analytics'] },
        },
      ],
    });
    const report = run(charter, [manifestFor(ana, charter, hold('dat402'))], [dat402]);
    expect(report.cells[0]).toMatchObject({ count: 1, target: 2, state: 'under' });
  });

  it('counts a member once even when they hold two sessions of the topic that day', () => {
    const charter = baseCharter();
    const report = run(
      charter,
      [manifestFor(luis, charter, hold('dat402', 'dat404'))],
      [dat402, dat404],
    );
    expect(report.cells.find((c) => c.topicId === 'data')?.count).toBe(1);
  });

  it('leaves maybes out unless asked', () => {
    const charter = baseCharter();
    const maybe: ManifestSession[] = [{ sessionId: 'dat402', code: 'DAT402', status: 'maybe' }];
    const m = manifestFor(ana, charter, maybe);
    expect(heldSessions(m)).toEqual([]);
    expect(heldSessions(m, true)).toHaveLength(1);
    expect(run(charter, [m], [dat402]).cells.find((c) => c.topicId === 'data')?.count).toBe(0);
    expect(
      run(charter, [m], [dat402], { includeMaybe: true }).cells.find((c) => c.topicId === 'data')
        ?.count,
    ).toBe(1);
  });

  it('orders days ascending and uses event-local days (late evening stays on its day)', () => {
    const charter = baseCharter();
    const late = session({
      sessionId: 'late',
      code: 'AGT501',
      startMin: at(23),
      endMin: at(23, 50),
    });
    const report = run(charter, [], [opsR1, late, dat402]);
    expect(report.days).toEqual([localDay(at(0), PST), localDay(at(0, 0, 1), PST)]);
  });

  it('matches taxonomy labels regardless of case and punctuation', () => {
    const charter = baseCharter();
    const s = session({ sessionId: 'x', topics: ['  security AND compliance '] });
    expect(topicIdsOf(s, charter)).toEqual(['security']);
  });
});

describe('must-cover gaps', () => {
  const charter = (mustCover: string[]) =>
    baseCharter({
      mustCover: mustCover.map((sessionId) => ({ sessionId })),
      lunch: { start: '12:00', end: '13:00', protected: true },
    });

  it('lists a must-cover session nobody holds, and notes that it collides with lunch', () => {
    const c = charter(['sec301']);
    const report = run(c, [manifestFor(ana, c, hold('ops-r'))], [sec301, opsR]);
    expect(report.gaps).toEqual([
      {
        sessionId: 'sec301',
        code: 'SEC301',
        day: localDay(at(12), PST),
        reason: 'nobody',
        collidesWithLunch: true,
      },
    ]);
  });

  it('does not list a must-cover session once someone holds it', () => {
    const c = charter(['sec301']);
    expect(run(c, [manifestFor(marta, c, hold('sec301'))], [sec301]).gaps).toEqual([]);
  });

  it('reports a must-cover session the catalog does not contain', () => {
    const c = charter(['gone']);
    expect(run(c, [], [opsR]).gaps).toEqual([
      {
        sessionId: 'gone',
        code: undefined,
        day: undefined,
        reason: 'not-in-catalog',
        collidesWithLunch: false,
      },
    ]);
  });

  it('only calls it a lunch collision when the window is protected and overlaps', () => {
    const c = charter([]);
    expect(collidesWithLunch(sec301, c, PST)).toBe(true);
    expect(collidesWithLunch(opsR, c, PST)).toBe(false);
    expect(
      collidesWithLunch(
        sec301,
        { ...c, lunch: { start: '12:00', end: '13:00', protected: false } },
        PST,
      ),
    ).toBe(false);
    expect(collidesWithLunch(sec301, { ...c, lunch: undefined }, PST)).toBe(false);
    const justAfter = session({ sessionId: 'a', startMin: at(13), endMin: at(14) });
    const justBefore = session({ sessionId: 'b', startMin: at(11), endMin: at(12) });
    expect(collidesWithLunch(justAfter, c, PST)).toBe(false);
    expect(collidesWithLunch(justBefore, c, PST)).toBe(false);
  });
});

describe('robustness', () => {
  it('gives the same report whatever order the manifests arrive in', () => {
    const charter = baseCharter();
    const manifests = [
      manifestFor(ana, charter, hold('ops-r', 'dat402')),
      manifestFor(luis, charter, hold('ops-r', 'dat402', 'dat404')),
      manifestFor(marta, charter, hold('sec301')),
    ];
    const forward = run(charter, manifests, [opsR, dat402, dat404, sec301]);
    expect(run(charter, [...manifests].reverse(), [opsR, dat402, dat404, sec301])).toEqual(forward);
    expect(
      run(charter, [manifests[1]!, manifests[2]!, manifests[0]!], [sec301, dat404, dat402, opsR]),
    ).toEqual(forward);
  });

  it('reports sessions in a manifest that the catalog does not have (catalogs differ)', () => {
    const charter = baseCharter();
    const report = run(charter, [manifestFor(ana, charter, hold('ops-r', 'ghost'))], [opsR]);
    expect(report.unknownSessions).toEqual([{ memberId: ana.memberId, sessionId: 'ghost' }]);
  });

  it('counts issues per day for the tabs: unplanned duplicates, impossible hops and gaps, not planned overlaps', () => {
    const charter = baseCharter({ mustCover: [{ sessionId: 'sec301' }] });
    const report = run(
      charter,
      [
        manifestFor(ana, charter, hold('ops-r')),
        manifestFor(luis, charter, hold('ops-r', 'dat402', 'dat404')),
      ],
      [opsR, dat402, dat404, sec301],
    );
    expect(issuesOnDay(report, localDay(at(9), PST))).toBe(3); // duplicate + hop + gap
    expect(issuesOnDay(report, localDay(at(9, 0, 1), PST))).toBe(0);
  });
});
