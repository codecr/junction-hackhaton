import { describe, expect, it } from 'vitest';
import { buildSquadView, canonicalJson, defaultVenueGraph } from '@junction/core';
import { generateDemo } from './generate';

const demo = generateDemo();
const input = {
  charter: demo.charter,
  manifests: demo.manifests,
  catalog: demo.snapshot,
  venueGraph: defaultVenueGraph,
};

describe('buildSquadView on the demo squad', () => {
  const view = buildSquadView(input);

  it('lists every member with a distinct colour and shape', () => {
    expect(view.members.map((m) => m.name)).toEqual(demo.members.map((m) => m.name));
    const pairs = new Set(view.members.map((m) => `${m.color}/${m.shape}`));
    expect(pairs.size).toBe(view.members.length);
  });

  it('includes every held and proposed session with local times', () => {
    for (const h of view.holdings) expect(view.sessions[h.sessionId]).toBeDefined();
    for (const p of view.proposals)
      for (const id of [...(p.add ?? []), ...(p.remove ?? [])])
        expect(view.sessions[id]).toBeDefined();
    for (const s of Object.values(view.sessions)) {
      expect(s.endLocal).toBeGreaterThan(s.startLocal);
      expect(s.startLocal).toBeGreaterThanOrEqual(0);
    }
  });

  it('names days with weekdays (Mon 30 Nov to Fri 4 Dec 2026)', () => {
    const first = view.days[0]!;
    expect([first.y, first.m, first.d, first.weekday]).toEqual([2026, 11, 30, 1]);
  });

  it('is identical regardless of manifest order', () => {
    const reversed = buildSquadView({ ...input, manifests: [...demo.manifests].reverse() });
    expect(canonicalJson(reversed)).toBe(canonicalJson(view));
  });

  it('venues follow Strip order', () => {
    expect(view.venues.map((v) => v.id)).toEqual([
      'wynn',
      'venetian',
      'caesars-forum',
      'mgm-grand',
      'mandalay-bay',
    ]);
  });
});
