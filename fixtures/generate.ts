// Generates the fictional demo squad. Everything here is invented: titles, speakers, rooms and
// ids. Nothing is derived from the real re:Invent catalog (CLAUDE.md rule 3).
//
// Two layers:
//   1. Authored: the Tuesday of design/reference.html, exactly, plus the squad's week of topic
//      coverage from the same file, so the coverage table can be reproduced.
//   2. Seeded filler: invented sessions to make the catalog about 120 sessions, including repeats.
// The authored layer ignores the seed. The seed only drives filler, and the same seed always gives
// byte-identical output.
import {
  catalogHash,
  defaultVenueGraph,
  keyPairFromSeed,
  memberIdFromPublicKey,
  parseInstantMinutes,
  sha256Bytes,
  signMessage,
  squadIdFrom,
  toBase64Url,
  toCatalogSessions,
  utf8,
  type CatalogSnapshot,
  type Charter,
  type Envelope,
  type Manifest,
  type ManifestSession,
  type SkipReason,
} from '@junction/core';

export const DEFAULT_SEED = 20261201;
export const UTC_OFFSET_MIN = -480; // Las Vegas in December: PST
const TIMEZONE = 'America/Los_Angeles';

// ---------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Integer operations only, so every platform agrees.
// ---------------------------------------------------------------------------------------------
export interface Rng {
  next(): number;
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    next,
    int: (n) => next() % n,
    pick: (items) => items[next() % items.length] as (typeof items)[number],
  };
}

// ---------------------------------------------------------------------------------------------
// Fixed vocabulary
// ---------------------------------------------------------------------------------------------
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
type DayKey = (typeof DAY_KEYS)[number];
const DATES: Record<DayKey, string> = {
  mon: '2026-11-30',
  tue: '2026-12-01',
  wed: '2026-12-02',
  thu: '2026-12-03',
  fri: '2026-12-04',
};

const VENUES = ['wynn', 'venetian', 'caesars-forum', 'mgm-grand', 'mandalay-bay'] as const;
const VENUE_NAMES: Record<(typeof VENUES)[number], string> = {
  wynn: 'Wynn',
  venetian: 'Venetian',
  'caesars-forum': 'Caesars Forum',
  'mgm-grand': 'MGM Grand',
  'mandalay-bay': 'Mandalay Bay',
};
type VenueId = (typeof VENUES)[number];

const TOPICS = [
  { id: 'agentic', label: 'Agentic AI', weight: 5, target: 2, prefixes: ['AGT', 'BSI'] },
  {
    id: 'security',
    label: 'Security and compliance',
    weight: 4,
    target: 1,
    prefixes: ['SEC', 'OPS'],
  },
  { id: 'data', label: 'Data and analytics', weight: 3, target: 1, prefixes: ['DAT'] },
  { id: 'containers', label: 'Containers', weight: 3, target: 1, prefixes: ['CON'] },
  { id: 'finops', label: 'Cost and FinOps', weight: 3, target: 1, prefixes: ['FIN'] },
  { id: 'serverless', label: 'Serverless', weight: 3, target: 1, prefixes: ['SVS'] },
] as const;
type TopicId = (typeof TOPICS)[number]['id'];

export const MEMBERS = [
  { key: 'ana', name: 'Ana', color: '--m1', shape: 'circle' },
  { key: 'luis', name: 'Luis', color: '--m2', shape: 'square' },
  { key: 'marta', name: 'Marta', color: '--m3', shape: 'diamond' },
  { key: 'diego', name: 'Diego', color: '--m4', shape: 'triangle' },
  { key: 'sofia', name: 'Sofía', color: '--m5', shape: 'cross' },
] as const;
type MemberKey = (typeof MEMBERS)[number]['key'];

// ---------------------------------------------------------------------------------------------
// Session drafts
// ---------------------------------------------------------------------------------------------
interface Draft {
  sessionId: string;
  code: string;
  title: string;
  venue: VenueId;
  day: DayKey;
  /** Minutes after local midnight. */
  start: number;
  length: number;
  topic: TopicId;
  type: string;
  level: string;
  features: string[];
  speakers: string[];
  seat: 'available' | 'limited' | 'veryLimited' | 'unavailable' | 'walkUp';
}

const t = (h: number, m = 0): number => h * 60 + m;

const authored = (
  code: string,
  title: string,
  venue: VenueId,
  day: DayKey,
  start: number,
  end: number,
  topic: TopicId,
  features: string[] = [],
): Draft => ({
  sessionId: `demo-${code.toLowerCase()}`,
  code,
  title,
  venue,
  day,
  start,
  length: end - start,
  topic,
  type: 'Breakout session',
  level: '300 - Advanced',
  features,
  speakers: [],
  seat: 'available',
});

/** The Tuesday of design/reference.html, as written there. */
const TUESDAY: Draft[] = [
  authored('AGT301', 'Agent memory in production', 'venetian', 'tue', t(9), t(10), 'agentic'),
  authored(
    'OPS305-R',
    'Guardrails for generated infrastructure',
    'venetian',
    'tue',
    t(10, 30),
    t(11, 30),
    'security',
    ['Community-led'],
  ),
  authored('DAT402', 'Zero-ETL at scale', 'mgm-grand', 'tue', t(13), t(14), 'data'),
  authored(
    'CON401',
    'Running EKS at 10,000 nodes',
    'caesars-forum',
    'tue',
    t(9, 30),
    t(11),
    'containers',
  ),
  authored(
    'SVS302',
    'Event-driven patterns that hold up',
    'caesars-forum',
    'tue',
    t(13, 30),
    t(15),
    'serverless',
  ),
  authored('AGT402', 'Multi-agent orchestration', 'venetian', 'tue', t(16), t(17), 'agentic'),
  authored('FIN301', 'Cost visibility for AI workloads', 'wynn', 'tue', t(8, 30), t(10), 'finops'),
  authored('AGT403', 'Evaluating agents', 'wynn', 'tue', t(10, 30), t(12), 'agentic'),
  authored('SEC303', 'Identity for agents', 'venetian', 'tue', t(14), t(15, 30), 'security'),
  authored('FIN302', 'Prompt caching economics', 'wynn', 'tue', t(13, 45), t(14, 45), 'finops'),
  authored(
    'AGT405',
    'Observability for agent fleets',
    'caesars-forum',
    'tue',
    t(15, 30),
    t(16, 30),
    'agentic',
  ),
  authored(
    'DAT404',
    'Vector search cost tuning',
    'mandalay-bay',
    'tue',
    t(14, 15),
    t(15, 15),
    'data',
  ),
  authored(
    'DAT301',
    'Streaming lakehouse ingestion',
    'mgm-grand',
    'tue',
    t(9, 15),
    t(10, 15),
    'data',
  ),
  authored(
    'SVS303',
    'Serverless data pipelines',
    'mgm-grand',
    'tue',
    t(10, 30),
    t(11, 15),
    'serverless',
  ),
  // Nobody covers these two: SEC301 falls in the squad lunch, BSI403 was added today.
  authored(
    'SEC301',
    'Compliance evidence, automated',
    'mgm-grand',
    'tue',
    t(12),
    t(13),
    'security',
  ),
  authored(
    'BSI403',
    'Shared memory for agent fleets',
    'wynn',
    'tue',
    t(16, 15),
    t(17, 15),
    'agentic',
  ),
  // The repeat of OPS305-R on Wednesday. A different format, as repeats can be.
  authored(
    'OPS305-R1',
    'Guardrails for generated infrastructure',
    'venetian',
    'wed',
    t(16),
    t(17),
    'security',
    ['Customer story'],
  ),
];

const TUESDAY_PLAN: Record<MemberKey, string[]> = {
  ana: ['AGT301', 'OPS305-R', 'FIN302', 'AGT405'],
  luis: ['AGT301', 'OPS305-R', 'DAT402', 'DAT404'],
  marta: ['CON401', 'SVS302', 'AGT402'],
  diego: ['FIN301', 'AGT403', 'SEC303'],
  sofia: ['DAT301', 'SVS303'],
};

/** Who covers which topic on the other days, from the coverage table in design/reference.html. */
const WEEK: Record<TopicId, Partial<Record<DayKey, MemberKey[]>>> = {
  agentic: { mon: ['ana', 'diego'], wed: ['marta'], thu: ['ana', 'sofia'], fri: ['diego'] },
  security: { mon: ['luis'], wed: ['ana'], thu: [], fri: ['diego'] },
  data: { mon: ['sofia'], wed: [], thu: ['sofia', 'luis'], fri: ['luis'] },
  containers: { mon: ['marta'], wed: ['marta', 'sofia'], thu: ['sofia'], fri: ['sofia'] },
  finops: { mon: ['diego'], wed: ['ana'], thu: ['diego'], fri: ['ana'] },
  serverless: { mon: ['sofia'], wed: [], thu: ['marta'], fri: ['marta'] },
};

/** Ana's Wednesday stays at the Venetian so the OPS305-R1 swap can fit there. */
const HOME_OVERRIDE: Partial<Record<`${MemberKey}:${DayKey}`, VenueId>> = { 'ana:wed': 'venetian' };

const MEMBER_SLOTS = [t(9), t(10, 30), t(13), t(14, 30), t(16)];

// Invented words for titles and names.
const ADJECTIVES = [
  'Practical',
  'Lean',
  'Resilient',
  'Composable',
  'Observable',
  'Frugal',
  'Hardened',
  'Portable',
  'Incremental',
  'Verifiable',
];
const NOUNS = [
  'pipelines',
  'queues',
  'schemas',
  'gateways',
  'fleets',
  'ledgers',
  'caches',
  'workflows',
  'replicas',
  'manifests',
];
const CONTEXTS = [
  'for small teams',
  'under load',
  'without downtime',
  'at the edge',
  'in regulated settings',
  'on a tight budget',
  'across regions',
  'from scratch',
];
const SPEAKERS = [
  'Rowan Alder',
  'Mina Okafor',
  'Teodor Vance',
  'Iris Lindqvist',
  'Calla Brandt',
  'Joaquin Rey',
  'Noor Haddad',
  'Pavel Ostrow',
];
const TYPES = ['Breakout session', 'Chalk talk', 'Workshop', 'Lightning talk'];
const LEVELS = ['200 - Intermediate', '300 - Advanced', '400 - Expert'];
const FEATURE_SETS: string[][] = [[], ['Interactive'], ['Hands-on'], ['Customer story']];
const SEATS = [
  'available',
  'available',
  'available',
  'limited',
  'veryLimited',
  'unavailable',
  'walkUp',
] as const;

const FILLER_PER_DAY: Record<DayKey, number> = { mon: 15, tue: 10, wed: 15, thu: 15, fri: 13 };

interface Built {
  drafts: Draft[];
  /** Sessions created for the week's coverage table, and the member who holds each. */
  owners: Map<string, MemberKey>;
}

function buildDrafts(rng: Rng): Built {
  const drafts: Draft[] = [...TUESDAY];
  const owners = new Map<string, MemberKey>();
  const usedCodes = new Set(TUESDAY.map((d) => d.code.replace(/-R\d*$/, '')));
  const usedTitles = new Set(TUESDAY.map((d) => d.title));
  let counter = 0;

  const freshTitle = (): string => {
    for (;;) {
      const title = `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} ${rng.pick(CONTEXTS)}`;
      if (!usedTitles.has(title)) {
        usedTitles.add(title);
        return title;
      }
    }
  };
  const freshCode = (topic: TopicId): string => {
    const prefixes = TOPICS.find((x) => x.id === topic)?.prefixes ?? ['AGT'];
    for (;;) {
      // Filler numbers stay in 700 to 899, a range the real catalog does not use.
      const code = `${rng.pick(prefixes)}${700 + rng.int(200)}`;
      if (!usedCodes.has(code)) {
        usedCodes.add(code);
        return code;
      }
    }
  };
  const fresh = (
    day: DayKey,
    venue: VenueId,
    start: number,
    length: number,
    topic: TopicId,
  ): Draft => {
    counter += 1;
    const speakerCount = rng.int(3);
    return {
      sessionId: `demo-gen-${String(counter).padStart(3, '0')}`,
      code: freshCode(topic),
      title: freshTitle(),
      venue,
      day,
      start,
      length,
      topic,
      type: rng.pick(TYPES),
      level: rng.pick(LEVELS),
      features: [...rng.pick(FEATURE_SETS)],
      speakers: Array.from({ length: speakerCount }, () => rng.pick(SPEAKERS)),
      seat: rng.pick(SEATS),
    };
  };

  // Layer 1b: the sessions that make the week's coverage table match the reference.
  // One venue per member and day, so a member's own sessions never need a walk.
  for (const day of DAY_KEYS) {
    if (day === 'tue') continue;
    for (const member of MEMBERS) {
      const slots = TOPICS.filter((topic) => WEEK[topic.id][day]?.includes(member.key));
      if (slots.length === 0) continue;
      const venue = HOME_OVERRIDE[`${member.key}:${day}`] ?? rng.pick(VENUES);
      slots.forEach((topic, i) => {
        const draft = fresh(day, venue, MEMBER_SLOTS[i] ?? t(17), 60, topic.id);
        draft.seat = 'available';
        drafts.push(draft);
        owners.set(draft.sessionId, member.key);
      });
    }
  }

  // Layer 2: unattended filler.
  const fillers: Draft[] = [];
  for (const day of DAY_KEYS) {
    for (let i = 0; i < FILLER_PER_DAY[day]; i++) {
      const venue = rng.pick(VENUES);
      const start = t(8) + 30 * rng.int(19);
      const length = rng.pick([45, 60, 90]);
      const topic = rng.pick(TOPICS).id;
      fillers.push(fresh(day, venue, start, length, topic));
    }
  }
  drafts.push(...fillers);

  // Repeats: every fifth early-week filler gets a copy a day or two later, in the same format
  // or, for odd ones, with a different feature label.
  const early = fillers.filter((d) => d.day === 'mon' || d.day === 'tue' || d.day === 'wed');
  early.forEach((original, i) => {
    if (i % 5 !== 0) return;
    const base = original.code;
    const laterDay = DAY_KEYS[DAY_KEYS.indexOf(original.day) + 1 + rng.int(2)] as DayKey;
    original.code = `${base}-R`;
    drafts.push({
      ...original,
      sessionId: `${original.sessionId}-r1`,
      code: `${base}-R1`,
      day: laterDay,
      features: i % 10 === 0 ? ['Customer story'] : [...original.features],
    });
  });

  drafts.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return { drafts, owners };
}

// ---------------------------------------------------------------------------------------------
// Draft to API-shaped session (field names from the official OpenAPI)
// ---------------------------------------------------------------------------------------------
const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function toApiSession(d: Draft): Record<string, unknown> {
  const topic = TOPICS.find((x) => x.id === d.topic);
  return {
    sessionId: d.sessionId,
    title: d.title,
    abbreviation: d.code,
    type: d.type,
    level: d.level,
    venue: VENUE_NAMES[d.venue],
    room: `Room ${d.code.replace(/\D/g, '').slice(0, 3)}`,
    isAllDaySession: false,
    isReservable: d.seat !== 'walkUp',
    seatAvailability: d.seat,
    sessionTime: {
      date: DATES[d.day],
      time: clock(d.start),
      length: String(d.length),
      timezone: TIMEZONE,
    },
    speakers: d.speakers.map((name) => ({ name })),
    topics: [topic?.label ?? ''],
    features: d.features,
  };
}

// ---------------------------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------------------------
export interface DemoMember {
  key: MemberKey;
  name: string;
  color: string;
  shape: string;
  memberId: string;
}

export interface DemoData {
  seed: number;
  members: DemoMember[];
  charter: Charter;
  manifests: Manifest[];
  envelopes: { charter: Envelope; manifests: Envelope[] };
  apiSessions: Record<string, unknown>[];
  snapshot: CatalogSnapshot;
  skipped: SkipReason[];
}

// The label is arbitrary. This one makes Ana's member id sort before Luis's, so the solver's
// tie-break (lowest member id) addresses the OPS305-R1 swap to Ana, as in design/reference.html.
const KEY_LABEL = 'junction-demo-key-v4';
const memberKeys = (key: string) => keyPairFromSeed(sha256Bytes(utf8(`${KEY_LABEL}:${key}`)));

export function generateDemo(seed: number = DEFAULT_SEED): DemoData {
  const rng = makeRng(seed);
  const { drafts, owners } = buildDrafts(rng);
  const apiSessions = drafts.map(toApiSession);
  const { sessions, skipped } = toCatalogSessions(apiSessions, {
    utcOffsetMin: UTC_OFFSET_MIN,
    venueGraph: defaultVenueGraph,
  });
  const snapshot: CatalogSnapshot = {
    eventId: 'reinvent2026',
    utcOffsetMin: UTC_OFFSET_MIN,
    sessions,
  };

  const members: DemoMember[] = MEMBERS.map((m) => ({
    key: m.key,
    name: m.name,
    color: m.color,
    shape: m.shape,
    memberId: memberIdFromPublicKey(memberKeys(m.key).publicKey),
  }));
  const leader = memberKeys('ana');
  const squadId = squadIdFrom(
    leader.publicKey,
    sha256Bytes(utf8('junction-demo-squad')).slice(0, 16),
  );
  const idOf = (key: MemberKey): string => members.find((m) => m.key === key)?.memberId ?? '';

  const charter: Charter = {
    v: 1,
    type: 'charter',
    squadId,
    name: 'Demo squad',
    eventId: 'reinvent2026',
    leader: idOf('ana'),
    seq: 1,
    issuedAt: '2026-10-05T18:00:00Z',
    expiresAt: '2026-12-18T00:00:00Z',
    inviteVerifier: toBase64Url(sha256Bytes(utf8('junction-demo-invite'))),
    members: MEMBERS.map((m, i) => ({
      memberId: idOf(m.key),
      name: m.name,
      publicKey: toBase64Url(memberKeys(m.key).publicKey),
      role: i === 0 ? ('leader' as const) : ('member' as const),
      joinedAt: '2026-10-05T18:00:00Z',
    })),
    topics: TOPICS.map((topic) => ({
      id: topic.id,
      label: topic.label,
      weight: topic.weight,
      target: topic.target,
      match: { topics: [topic.label] },
    })),
    mustCover: [{ sessionId: 'demo-sec301' }, { sessionId: 'demo-bsi403' }],
    lunch: { start: '12:00', end: '13:00', protected: true },
    caps: { maxPerDay: 5 },
    travel: { bufferMin: 0 },
    tolerance: 0.2,
  };

  // Who holds what.
  const byCode = new Map(drafts.map((d) => [d.code, d]));
  const held = new Map<MemberKey, { draft: Draft; status: 'reserved' | 'favorite' }[]>();
  for (const member of MEMBERS) {
    const list: { draft: Draft; status: 'reserved' | 'favorite' }[] = [];
    for (const code of TUESDAY_PLAN[member.key]) {
      const draft = byCode.get(code);
      if (draft) list.push({ draft, status: 'reserved' });
    }
    held.set(member.key, list);
  }
  for (const [sessionId, owner] of owners) {
    const draft = drafts.find((d) => d.sessionId === sessionId);
    if (draft) held.get(owner)?.push({ draft, status: 'favorite' });
  }

  const startOf = (d: Draft): number =>
    (parseInstantMinutes(`${DATES[d.day]}T00:00:00Z`) ?? 0) + d.start - UTC_OFFSET_MIN;
  const fullHash = catalogHash(sessions);
  const withoutNew = catalogHash(sessions.filter((s) => s.sessionId !== 'demo-bsi403'));

  const manifests: Manifest[] = MEMBERS.map((m) => {
    const list = [...(held.get(m.key) ?? [])].sort(
      (a, b) =>
        startOf(a.draft) - startOf(b.draft) || (a.draft.sessionId < b.draft.sessionId ? -1 : 1),
    );
    const sessionsHeld: ManifestSession[] = list.map(({ draft, status }) => ({
      sessionId: draft.sessionId,
      code: draft.code,
      status,
    }));
    return {
      v: 1,
      type: 'manifest',
      squadId,
      memberId: idOf(m.key),
      seq: 1,
      issuedAt: '2026-10-08T15:04:05Z',
      eventId: 'reinvent2026',
      // Marta's catalog is one update behind: she has not seen BSI403 yet.
      catalogHash: m.key === 'marta' ? withoutNew : fullHash,
      share: 'L0',
      sessions: sessionsHeld,
    };
  });

  const envelopes = {
    charter: signMessage(charter, charter.leader, leader.secretKey),
    manifests: manifests.map((manifest) =>
      signMessage(
        manifest,
        manifest.memberId,
        memberKeys(MEMBERS.find((m) => idOf(m.key) === manifest.memberId)?.key ?? '').secretKey,
      ),
    ),
  };

  return { seed, members, charter, manifests, envelopes, apiSessions, snapshot, skipped };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** File name (inside fixtures/demo) to exact file contents. */
export function renderFiles(data: DemoData): Record<string, string> {
  return {
    'sessions.api.json': json(data.apiSessions),
    'snapshot.json': json(data.snapshot),
    'squad.json': json({
      seed: data.seed,
      members: data.members,
      charter: data.charter,
      manifests: data.manifests,
    }),
    'envelopes.json': json(data.envelopes),
  };
}
