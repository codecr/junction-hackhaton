import type { CatalogSession, CatalogSnapshot } from '../src/catalog';
import type { SolverInput } from '../src/solver';
import type { Charter, Manifest, ManifestSession } from '../src/schemas';
import { parseInstantMinutes } from '../src/time';
import { defaultVenueGraph } from '../src/venues';
import { session } from './catalog-builders';
import { testCharter, testManifest, testMember, type TestMember } from './helpers';

export const PST = -480;
const MIDNIGHT_TUE = parseInstantMinutes('2026-12-01T08:00:00Z')!; // 00:00 PST on 1 December
/** Epoch minutes for a local clock time. `day` 0 is Tuesday 1 December. */
export const at = (h: number, m = 0, day = 0): number => MIDNIGHT_TUE + day * 1440 + h * 60 + m;

export const ana = testMember('Ana', 1);
export const luis = testMember('Luis', 2);
export const marta = testMember('Marta', 3);
export const diego = testMember('Diego', 4);
export const people = [ana, luis, marta, diego];

export const topicsCharter = (overrides: Partial<Charter> = {}): Charter =>
  testCharter(people, {
    topics: [
      { id: 'security', label: 'Security', weight: 4, target: 1, match: { topics: ['Security'] } },
      { id: 'data', label: 'Data', weight: 3, target: 1, match: { topics: ['Data'] } },
      { id: 'agentic', label: 'Agentic', weight: 5, target: 2, match: { topics: ['Agentic'] } },
    ],
    tolerance: 0.2,
    ...overrides,
  });

export const snapshot = (sessions: CatalogSession[]): CatalogSnapshot => ({
  eventId: 'reinvent2026',
  utcOffsetMin: PST,
  sessions,
});

export const hold = (...ids: string[]): ManifestSession[] =>
  ids.map((sessionId) => ({ sessionId, code: 'AGT301', status: 'reserved' as const }));

export const manifestFor = (
  member: TestMember,
  charter: Charter,
  sessions: ManifestSession[],
  overrides: Partial<Manifest> = {},
): Manifest => testManifest(member, charter, { sessions, ...overrides });

export const input = (
  charter: Charter,
  manifests: Manifest[],
  sessions: CatalogSession[],
  extra: Partial<SolverInput> = {},
): SolverInput => ({
  charter,
  manifests,
  catalog: snapshot(sessions),
  venueGraph: defaultVenueGraph,
  ...extra,
});

/** A security session at the Venetian, with room for overrides. */
export const secSession = (
  sessionId: string,
  code: string,
  startH: number,
  startM: number,
  lengthMin: number,
  extra: Partial<CatalogSession> = {},
  day = 0,
): CatalogSession =>
  session({
    sessionId,
    code,
    title: `Title of ${sessionId}`,
    venue: 'venetian',
    topics: ['Security'],
    startMin: at(startH, startM, day),
    endMin: at(startH, startM, day) + lengthMin,
    ...extra,
  });
