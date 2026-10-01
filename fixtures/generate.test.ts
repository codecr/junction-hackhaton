import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyseCoverage,
  catalogSnapshotSchema,
  charterSchema,
  defaultVenueGraph,
  findRepeatGroups,
  groupOf,
  issuesOnDay,
  localDay,
  manifestSchema,
  openCharter,
  openMessage,
  parseInstantMinutes,
  sha256Hex,
  type CoverageReport,
} from '@junction/core';
import { DEFAULT_SEED, MEMBERS, generateDemo, makeRng, renderFiles } from './generate';

const here = dirname(fileURLToPath(import.meta.url));
const demo = generateDemo();
const memberId = (key: string): string => demo.members.find((m) => m.key === key)?.memberId ?? '';
const idsOf = (...keys: string[]): string[] => keys.map(memberId).sort();

const report: CoverageReport = analyseCoverage({
  charter: demo.charter,
  manifests: demo.manifests,
  catalog: demo.snapshot,
  venueGraph: defaultVenueGraph,
});
const day = (date: string): number => localDay(parseInstantMinutes(`${date}T12:00:00Z`)!, -480);
const TUE = day('2026-12-01');
const cell = (topicId: string, date: string) =>
  report.cells.find((c) => c.topicId === topicId && c.day === day(date));

describe('determinism', () => {
  it('gives byte-identical files for the same seed', () => {
    expect(renderFiles(generateDemo(DEFAULT_SEED))).toEqual(
      renderFiles(generateDemo(DEFAULT_SEED)),
    );
  });

  it('changes only the filler when the seed changes: the reference Tuesday is fixed', () => {
    const other = generateDemo(42);
    expect(renderFiles(other)['snapshot.json']).not.toBe(renderFiles(demo)['snapshot.json']);
    const authored = (d: typeof demo) =>
      d.snapshot.sessions.filter((s) => !s.sessionId.startsWith('demo-gen-'));
    expect(authored(other)).toEqual(authored(demo));
    expect(
      other.manifests.map((m) => m.sessions.filter((s) => !s.sessionId.startsWith('demo-gen-'))),
    ).toEqual(
      demo.manifests.map((m) => m.sessions.filter((s) => !s.sessionId.startsWith('demo-gen-'))),
    );
  });

  it('matches the committed files in fixtures/demo (run npm run fixtures if this fails)', () => {
    for (const [name, content] of Object.entries(renderFiles(demo))) {
      expect(readFileSync(join(here, 'demo', name), 'utf8'), name).toBe(content);
    }
  });

  it('uses a PRNG whose first values are fixed, so every platform agrees', () => {
    // Reference values from the published mulberry32 implementation, computed independently.
    const rng = makeRng(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      2_693_262_067, 11_749_833, 2_265_367_787,
    ]);
    const seeded = makeRng(DEFAULT_SEED);
    expect([seeded.next(), seeded.next(), seeded.next()]).toEqual([
      1_214_187_109, 1_007_508_439, 461_233_435,
    ]);
  });

  it('has a pinned hash for the default seed (golden, must match on Linux, macOS and Windows)', () => {
    expect(sha256Hex(Object.values(renderFiles(demo)).join('\n'))).toBe(
      'a8a9d165063325db91372c9acdb31fdd00de0b45f902977dce89f2438901fba4',
    );
  });
});

describe('the squad', () => {
  it('has five members, each with its own colour token, marker shape and name', () => {
    expect(demo.members.map((m) => [m.name, m.color, m.shape])).toEqual([
      ['Ana', '--m1', 'circle'],
      ['Luis', '--m2', 'square'],
      ['Marta', '--m3', 'diamond'],
      ['Diego', '--m4', 'triangle'],
      ['Sofía', '--m5', 'cross'],
    ]);
    expect(MEMBERS).toHaveLength(5);
  });

  it('has a charter and manifests that validate and verify', () => {
    expect(charterSchema.safeParse(demo.charter).success).toBe(true);
    for (const manifest of demo.manifests)
      expect(manifestSchema.safeParse(manifest).success).toBe(true);
    const charter = openCharter(demo.envelopes.charter);
    expect(charter.ok).toBe(true);
    for (const envelope of demo.envelopes.manifests) {
      expect(openMessage(envelope, demo.charter).ok).toBe(true);
    }
  });

  it('is fictional: invented ids, a demo squad name, and no emails', () => {
    const text = Object.values(renderFiles(demo)).join('\n');
    expect(text).not.toMatch(/@/);
    expect(demo.charter.name).toBe('Demo squad');
    expect(demo.snapshot.sessions.every((s) => s.sessionId.startsWith('demo-'))).toBe(true);
  });

  it("marks Marta's catalog as one update behind (provisional proposals)", () => {
    const hashes = new Map(demo.manifests.map((m) => [m.memberId, m.catalogHash]));
    const distinct = new Set(hashes.values());
    expect(distinct.size).toBe(2);
    expect(hashes.get(memberId('marta'))).not.toBe(hashes.get(memberId('ana')));
    expect(hashes.get(memberId('ana'))).toBe(hashes.get(memberId('luis')));
  });
});

describe('the catalog', () => {
  it('has about 120 invented sessions that the API mapper accepts without skipping any', () => {
    expect(demo.skipped).toEqual([]);
    expect(demo.snapshot.sessions.length).toBeGreaterThanOrEqual(100);
    expect(demo.snapshot.sessions.length).toBeLessThanOrEqual(140);
    expect(demo.apiSessions).toHaveLength(demo.snapshot.sessions.length);
    expect(catalogSnapshotSchema.safeParse(demo.snapshot).success).toBe(true);
  });

  it('uses the field names of the official OpenAPI', () => {
    const first = demo.apiSessions[0]!;
    expect(Object.keys(first)).toEqual(
      expect.arrayContaining([
        'sessionId',
        'title',
        'abbreviation',
        'venue',
        'room',
        'sessionTime',
        'seatAvailability',
      ]),
    );
    expect(first.sessionTime).toMatchObject({ timezone: 'America/Los_Angeles' });
    expect(first).not.toHaveProperty('abstract');
  });

  it('spans five days and all five venues, with unique ids and codes', () => {
    const s = demo.snapshot.sessions;
    expect(new Set(s.map((x) => x.sessionId)).size).toBe(s.length);
    expect(new Set(s.map((x) => x.venue)).size).toBe(5);
    expect(report.days).toHaveLength(5);
  });

  it('keeps invented filler codes in a range the real catalog does not use', () => {
    const filler = demo.snapshot.sessions.filter((x) => x.sessionId.startsWith('demo-gen-'));
    expect(filler.length).toBeGreaterThan(60);
    for (const x of filler) {
      const n = Number(/\d+/.exec(x.code)?.[0]);
      expect(n).toBeGreaterThanOrEqual(700);
      expect(n).toBeLessThan(900);
    }
  });

  it('has repeats with -R and -R1 codes, some that differ in format', () => {
    const analysis = findRepeatGroups(demo.snapshot.sessions);
    const high = analysis.groups.filter((g) => g.confidence === 'high');
    expect(high.length).toBeGreaterThanOrEqual(8);
    expect(demo.snapshot.sessions.some((s) => /-R$/.test(s.code))).toBe(true);
    expect(demo.snapshot.sessions.some((s) => /-R1$/.test(s.code))).toBe(true);
    expect(high.some((g) => g.differences.includes('features'))).toBe(true);
    expect(high.some((g) => !g.differences.includes('features'))).toBe(true);
    expect(analysis.flags).toEqual([]);
  });

  it('has OPS305-R1 on Wednesday, in the same group as OPS305-R, held by nobody', () => {
    const analysis = findRepeatGroups(demo.snapshot.sessions);
    const group = groupOf(analysis, 'demo-ops305-r');
    expect(group?.sessionIds).toEqual(['demo-ops305-r', 'demo-ops305-r1']);
    expect(group?.differences).toEqual(['features', 'start']);
    expect(
      demo.manifests.some((m) => m.sessions.some((s) => s.sessionId === 'demo-ops305-r1')),
    ).toBe(false);
  });

  it('has every held session in the catalog', () => {
    expect(report.unknownSessions).toEqual([]);
  });
});

describe('the reference Tuesday (design/reference.html)', () => {
  it('gives the same plan to every member', () => {
    const tuesday = (key: string) =>
      demo.manifests
        .find((m) => m.memberId === memberId(key))!
        .sessions.filter((s) => s.status === 'reserved')
        .map((s) => s.code);
    expect(tuesday('ana')).toEqual(['AGT301', 'OPS305-R', 'FIN302', 'AGT405']);
    expect(tuesday('luis')).toEqual(['AGT301', 'OPS305-R', 'DAT402', 'DAT404']);
    expect(tuesday('marta')).toEqual(['CON401', 'SVS302', 'AGT402']);
    expect(tuesday('diego')).toEqual(['FIN301', 'AGT403', 'SEC303']);
    expect(tuesday('sofia')).toEqual(['DAT301', 'SVS303']);
  });

  it('has 2 sessions nobody covers: SEC301 (lunch) and BSI403 (new today)', () => {
    expect(report.gaps.map((g) => [g.code, g.collidesWithLunch])).toEqual([
      ['SEC301', true],
      ['BSI403', false],
    ]);
  });

  it('has 1 unplanned duplicate (OPS305-R) and 1 planned overlap (AGT301)', () => {
    const unplanned = report.duplicates.filter((d) => !d.planned);
    expect(unplanned.map((d) => d.code)).toEqual(['OPS305-R']);
    expect(unplanned[0]?.attendees).toEqual(idsOf('ana', 'luis'));
    const planned = report.duplicates.filter((d) => d.planned);
    expect(planned.map((d) => d.code)).toEqual(['AGT301']);
    expect(planned[0]?.attendees).toEqual(idsOf('ana', 'luis'));
  });

  it('has 1 connection that cannot be made: Luis needs 28 min and has 15', () => {
    expect(report.hops).toHaveLength(1);
    expect(report.hops[0]).toMatchObject({
      memberId: memberId('luis'),
      fromSessionId: 'demo-dat402',
      toSessionId: 'demo-dat404',
      needMin: 28,
      haveMin: 15,
    });
    expect(report.unjudgedHops).toEqual([]);
  });

  it('counts 4 issues on Tuesday and none on the other days, as the day tab says', () => {
    expect(issuesOnDay(report, TUE)).toBe(4);
    for (const date of ['2026-11-30', '2026-12-02', '2026-12-03', '2026-12-04']) {
      expect(issuesOnDay(report, day(date)), date).toBe(0);
    }
  });

  it('reproduces the Tuesday column of the coverage table', () => {
    const members = (topic: string) => cell(topic, '2026-12-01')?.members;
    expect(members('agentic')).toEqual(idsOf('ana', 'luis', 'marta', 'diego'));
    expect(members('security')).toEqual(idsOf('ana', 'luis', 'diego'));
    expect(members('data')).toEqual(idsOf('luis', 'sofia'));
    expect(members('containers')).toEqual(idsOf('marta'));
    expect(members('finops')).toEqual(idsOf('ana', 'diego'));
    expect(members('serverless')).toEqual(idsOf('marta', 'sofia'));
  });
});

describe('the week (coverage table of design/reference.html)', () => {
  it('has the 3 hatched "none" cells', () => {
    const none = report.cells
      .filter((c) => c.state === 'none')
      .map((c) => `${c.topicId} ${c.day - TUE}`);
    expect(none.sort()).toEqual(['data 1', 'security 2', 'serverless 1']);
  });

  it('has the 2 "1 of 2" cells for Agentic AI', () => {
    const under = report.cells.filter((c) => c.state === 'under');
    // Days counted from Tuesday: Wednesday is 1, Friday is 3.
    expect(under.map((c) => [c.topicId, c.day - TUE, c.count, c.target])).toEqual([
      ['agentic', 1, 1, 2],
      ['agentic', 3, 1, 2],
    ]);
  });

  it('puts the members from the reference in the Monday, Thursday and Friday cells', () => {
    expect(cell('agentic', '2026-11-30')?.members).toEqual(idsOf('ana', 'diego'));
    expect(cell('agentic', '2026-12-03')?.members).toEqual(idsOf('ana', 'sofia'));
    expect(cell('data', '2026-12-03')?.members).toEqual(idsOf('sofia', 'luis'));
    expect(cell('containers', '2026-12-02')?.members).toEqual(idsOf('marta', 'sofia'));
  });

  it('never makes a member walk further than the time they have outside Tuesday', () => {
    expect(report.hops.every((h) => h.day === TUE)).toBe(true);
  });
});
