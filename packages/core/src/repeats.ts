import { compareStrings } from './bytes';
import type { CatalogSession } from './catalog';
import { parseCode } from './codes';
import { normalizeText } from './text';

// PROVISIONAL until Spike 0 confirms how real repeats look (docs/03, "Session code parsing").

export type DifferenceField = 'type' | 'features' | 'level' | 'speakers' | 'start' | 'venue';

const FIELD_ORDER: readonly DifferenceField[] = [
  'type',
  'features',
  'level',
  'speakers',
  'start',
  'venue',
];

export interface RepeatGroup {
  /** `base|normalised title` for high confidence, `~title|level|type` for probable. */
  key: string;
  /** high: same base code and title. probable: only title, level and type match across bases. */
  confidence: 'high' | 'probable';
  /** Ordered by start time, then session id. */
  sessionIds: string[];
  /** Fields that are not identical across the group. Repeats are not always identical. */
  differences: DifferenceField[];
}

export interface RepeatFlag {
  kind: 'same-base-different-title';
  base: string;
  sessionIds: string[];
}

export interface RepeatAnalysis {
  groups: RepeatGroup[];
  flags: RepeatFlag[];
}

const list = (values: readonly string[] | undefined): string =>
  [...(values ?? [])].sort(compareStrings).join('\u0001');

function fieldValue(s: CatalogSession, field: DifferenceField): string {
  switch (field) {
    case 'type':
      return s.type ?? '';
    case 'level':
      return s.level ?? '';
    case 'features':
      return list(s.features);
    case 'speakers':
      return list(s.speakers);
    case 'start':
      return String(s.startMin);
    case 'venue':
      return s.venue;
  }
}

function differencesOf(members: readonly CatalogSession[]): DifferenceField[] {
  return FIELD_ORDER.filter((field) => new Set(members.map((s) => fieldValue(s, field))).size > 1);
}

const byStart = (a: CatalogSession, b: CatalogSession): number =>
  a.startMin - b.startMin || compareStrings(a.sessionId, b.sessionId);

function toGroup(
  key: string,
  confidence: 'high' | 'probable',
  members: CatalogSession[],
): RepeatGroup {
  const ordered = [...members].sort(byStart);
  return {
    key,
    confidence,
    sessionIds: ordered.map((s) => s.sessionId),
    differences: differencesOf(ordered),
  };
}

function bucket<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * Groups sessions that are repeats of one talk.
 * 1. Same base code and same normalised title: a high-confidence group.
 * 2. Same base code but different titles: not a group, flagged.
 * 3. Different base codes with the same title, level and type: a probable group.
 * Sessions with an empty title are never grouped, since there is nothing to compare.
 */
export function findRepeatGroups(sessions: readonly CatalogSession[]): RepeatAnalysis {
  const items = sessions
    .map((session) => ({
      session,
      base: parseCode(session.code)?.base,
      title: normalizeText(session.title),
    }))
    .filter(
      (item): item is { session: CatalogSession; base: string; title: string } =>
        item.base !== undefined && item.title !== '',
    );

  const groups: RepeatGroup[] = [];
  const flags: RepeatFlag[] = [];

  for (const [key, members] of bucket(items, (i) => `${i.base}|${i.title}`)) {
    if (members.length >= 2)
      groups.push(
        toGroup(
          key,
          'high',
          members.map((m) => m.session),
        ),
      );
  }

  for (const [base, members] of bucket(items, (i) => i.base)) {
    if (new Set(members.map((m) => m.title)).size > 1) {
      flags.push({
        kind: 'same-base-different-title',
        base,
        sessionIds: members
          .map((m) => m.session)
          .sort(byStart)
          .map((s) => s.sessionId),
      });
    }
  }

  const probable = bucket(
    items,
    (i) => `~${i.title}|${i.session.level ?? ''}|${i.session.type ?? ''}`,
  );
  for (const [key, members] of probable) {
    if (new Set(members.map((m) => m.base)).size >= 2) {
      groups.push(
        toGroup(
          key,
          'probable',
          members.map((m) => m.session),
        ),
      );
    }
  }

  groups.sort((a, b) => compareStrings(a.key, b.key));
  flags.sort((a, b) => compareStrings(a.base, b.base));
  return { groups, flags };
}

/** The high-confidence group a session belongs to, if any. */
export function groupOf(analysis: RepeatAnalysis, sessionId: string): RepeatGroup | undefined {
  return analysis.groups.find((g) => g.confidence === 'high' && g.sessionIds.includes(sessionId));
}
