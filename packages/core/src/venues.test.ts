import { describe, expect, it } from 'vitest';
import {
  defaultVenueGraph,
  normalizeVenue,
  venueGraphSchema,
  venueOrder,
  walkMinutes,
  type VenueGraph,
} from './venues';

describe('defaultVenueGraph', () => {
  it('is valid, marked approximate, and ordered along the Strip', () => {
    expect(venueGraphSchema.safeParse(defaultVenueGraph).success).toBe(true);
    expect(defaultVenueGraph.approximate).toBe(true);
    expect(venueOrder(defaultVenueGraph)).toEqual([
      'wynn',
      'venetian',
      'caesars-forum',
      'mgm-grand',
      'mandalay-bay',
    ]);
  });

  it('matches the walks printed in design/reference.html', () => {
    const w = (a: string, b: string) => walkMinutes(defaultVenueGraph, a, b);
    expect(w('wynn', 'venetian')).toBe(14);
    expect(w('venetian', 'caesars-forum')).toBe(22);
    expect(w('caesars-forum', 'mgm-grand')).toBe(30);
    expect(w('mgm-grand', 'mandalay-bay')).toBe(28);
  });
});

describe('walkMinutes', () => {
  it('is zero within a venue and symmetric between venues', () => {
    expect(walkMinutes(defaultVenueGraph, 'wynn', 'wynn')).toBe(0);
    expect(walkMinutes(defaultVenueGraph, 'wynn', 'mgm-grand')).toBe(
      walkMinutes(defaultVenueGraph, 'mgm-grand', 'wynn'),
    );
  });

  it('adds up along the Strip', () => {
    expect(walkMinutes(defaultVenueGraph, 'wynn', 'mandalay-bay')).toBe(94);
  });

  it('prefers an explicit edge over positions, in either direction', () => {
    const graph: VenueGraph = {
      ...defaultVenueGraph,
      edges: [{ from: 'wynn', to: 'venetian', minutes: 3 }],
    };
    expect(walkMinutes(graph, 'wynn', 'venetian')).toBe(3);
    expect(walkMinutes(graph, 'venetian', 'wynn')).toBe(3);
    expect(walkMinutes(graph, 'venetian', 'caesars-forum')).toBe(22);
  });

  it('is undefined for a venue the graph does not know', () => {
    expect(walkMinutes(defaultVenueGraph, 'wynn', 'nowhere')).toBeUndefined();
    expect(walkMinutes(defaultVenueGraph, 'nowhere', 'wynn')).toBeUndefined();
  });
});

describe('normalizeVenue', () => {
  it.each([
    ['Wynn', 'wynn'],
    ['  WYNN Las Vegas ', 'wynn'],
    ['The Venetian Expo, Level 2', 'venetian'],
    ['venetian', 'venetian'],
    ['MGM Grand Garden Arena', 'mgm-grand'],
    ['Mandalay Bay Convention Center', 'mandalay-bay'],
    ['Caesars Forum, Hall A', 'caesars-forum'],
  ])('maps %j to %s', (raw, id) => {
    expect(normalizeVenue(raw, defaultVenueGraph)).toBe(id);
  });

  it('prefers the longest spelling: Caesars Forum is not a bare Caesars match', () => {
    const graph: VenueGraph = {
      venues: [
        { id: 'caesars', name: 'Caesars Palace', at: 30 },
        { id: 'forum', name: 'Caesars Forum', at: 36 },
      ],
    };
    expect(normalizeVenue('Caesars Forum', graph)).toBe('forum');
  });

  it('matches whole words only', () => {
    expect(normalizeVenue('Wynnewood Arena', defaultVenueGraph)).toBeUndefined();
  });

  it('returns undefined for an unknown or empty venue', () => {
    expect(normalizeVenue('Somewhere Else', defaultVenueGraph)).toBeUndefined();
    expect(normalizeVenue('', defaultVenueGraph)).toBeUndefined();
  });

  it('breaks ties by venue id, independent of listing order', () => {
    const a: VenueGraph = {
      venues: [
        { id: 'b', name: 'Hall', at: 1 },
        { id: 'a', name: 'Hall', at: 2 },
      ],
    };
    const b: VenueGraph = { venues: [...a.venues].reverse() };
    expect(normalizeVenue('Hall', a)).toBe('a');
    expect(normalizeVenue('Hall', b)).toBe('a');
  });
});
