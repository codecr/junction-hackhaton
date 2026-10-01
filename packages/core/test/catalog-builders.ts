import type { CatalogSession } from '../src/catalog';

/** A minimal invented session. Titles and codes here are made up for tests. */
export function session(
  overrides: Partial<CatalogSession> & Pick<CatalogSession, 'sessionId'>,
): CatalogSession {
  return {
    code: 'AGT301',
    title: 'Invented talk',
    startMin: 28_000_000,
    endMin: 28_000_060,
    venue: 'venetian',
    ...overrides,
  };
}
