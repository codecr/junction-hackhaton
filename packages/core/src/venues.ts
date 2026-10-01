import { z } from 'zod';
import { compareStrings } from './bytes';
import { normalizeText } from './text';

// Walking time model. Each venue has a position `at` in minutes along the Strip, which the day
// chart uses so every walk has the same slope. Optional explicit edges override the position
// difference for the solver. The default graph is approximate until Spike 0 and real measurements.

export const venueDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().min(1).max(60),
  at: z.int().min(0),
  /** Extra spellings found in the catalog. The name itself always matches. */
  aliases: z.array(z.string()).optional(),
});

export const venueGraphSchema = z.strictObject({
  approximate: z.boolean().optional(),
  venues: z.array(venueDefSchema).min(1),
  edges: z
    .array(z.strictObject({ from: z.string(), to: z.string(), minutes: z.int().min(0) }))
    .optional(),
});

export type VenueDef = z.infer<typeof venueDefSchema>;
export type VenueGraph = z.infer<typeof venueGraphSchema>;

/** Positions are walking minutes along the Strip as drawn in design/reference.html. Approximate. */
export const defaultVenueGraph: VenueGraph = {
  approximate: true,
  venues: [
    { id: 'wynn', name: 'Wynn', at: 0, aliases: ['wynn las vegas', 'encore'] },
    {
      id: 'venetian',
      name: 'Venetian',
      at: 14,
      aliases: ['the venetian', 'venetian expo', 'palazzo'],
    },
    { id: 'caesars-forum', name: 'Caesars Forum', at: 36, aliases: ['forum', 'caesars'] },
    { id: 'mgm-grand', name: 'MGM Grand', at: 66, aliases: ['mgm'] },
    { id: 'mandalay-bay', name: 'Mandalay Bay', at: 94, aliases: ['mandalay'] },
  ],
};

/** Venue ids in Strip order: by position, ties by id. Drives the chart's vertical order. */
export function venueOrder(graph: VenueGraph): string[] {
  return [...graph.venues]
    .sort((a, b) => a.at - b.at || compareStrings(a.id, b.id))
    .map((v) => v.id);
}

/**
 * Maps a raw catalog venue string to a venue id, or undefined when nothing matches. A venue matches
 * when its name or an alias appears in the string as whole words. The longest alias wins, so
 * "Caesars Forum" is not mistaken for "Caesars". Ties go to the lower id.
 */
export function normalizeVenue(raw: string, graph: VenueGraph): string | undefined {
  const haystack = ` ${normalizeText(raw)} `;
  let best: { id: string; length: number } | undefined;
  for (const venue of graph.venues) {
    for (const spelling of [venue.name, ...(venue.aliases ?? [])]) {
      const needle = normalizeText(spelling);
      if (needle === '' || !haystack.includes(` ${needle} `)) continue;
      if (
        !best ||
        needle.length > best.length ||
        (needle.length === best.length && venue.id < best.id)
      ) {
        best = { id: venue.id, length: needle.length };
      }
    }
  }
  return best?.id;
}

/**
 * Walking minutes between two venues: 0 for the same venue, the explicit edge if one exists,
 * otherwise the difference of positions. Undefined when a venue is not in the graph.
 */
export function walkMinutes(graph: VenueGraph, from: string, to: string): number | undefined {
  if (from === to) return 0;
  const edge = graph.edges?.find(
    (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
  );
  if (edge) return edge.minutes;
  const a = graph.venues.find((v) => v.id === from);
  const b = graph.venues.find((v) => v.id === to);
  if (!a || !b) return undefined;
  return Math.abs(a.at - b.at);
}
