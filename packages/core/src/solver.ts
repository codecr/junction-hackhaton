import { compareStrings, sha256Hex } from './bytes';
import { canonicalJson } from './canonical';
import type { CatalogSnapshot } from './catalog';
import { rankClaimants } from './claim';
import { analyseCoverage, heldSessions, targetOf } from './coverage';
import { canAdd, makeContext, type FeasibilityContext } from './feasibility';
import { findRepeatGroups, groupOf, type DifferenceField } from './repeats';
import {
  DEFAULT_PRIORITY,
  isLocked,
  priorityOf,
  type Charter,
  type Manifest,
  type ManifestSession,
} from './schemas';
import type { VenueGraph } from './venues';

// The solver of docs/03. A pure function of (charter, manifests, catalog, venue graph): no clock,
// no randomness, integer milli-units, code point ordering. Proposals are independent: each is
// computed against the current schedules, not against the result of earlier proposals.

export type ProposalKind = 'SWAP' | 'CLAIM' | 'DROP' | 'MEET';

/** Machine reasons. The UI turns them into plain sentences. */
export type ReasonCode =
  | 'repeat-available'
  | 'owner-by-claim-rule'
  | 'covers-must-cover'
  | 'raises-coverage'
  | 'removes-duplicate'
  | 'fixes-connection';

export interface Proposal {
  /** sha256 (hex) of the canonical JSON of the proposal without this field. */
  id: string;
  kind: ProposalKind;
  /** Who is asked to act. */
  memberId: string;
  add?: string[];
  remove?: string[];
  meet?: { start: string; end: string; venue: string; members: string[] };
  /** Integer milli-units. */
  squadDelta: number;
  personalDelta: number;
  reasons: ReasonCode[];
  /** For repeat swaps: the fields that differ between the two sessions. */
  differences?: DifferenceField[];
  /** The members' catalogs differ, so this may change when they match. */
  provisional: boolean;
}

export interface SolverInput {
  charter: Charter;
  /** Verified manifests. If a member appears twice the highest seq wins. */
  manifests: readonly Manifest[];
  catalog: CatalogSnapshot;
  venueGraph: VenueGraph;
  /** Sessions that just appeared in the catalog and nobody holds. Candidates for CLAIM. */
  newSessions?: readonly string[];
}

export const MIN_SQUAD_GAIN = 50;
export const MUST_COVER_VALUE = 3000;
export const DUPLICATE_PENALTY = 500;
export const HOP_PENALTY = 2000;
export const PRIORITY_UNIT = 200;
export const MAX_PROPOSALS = 50;
const DEFAULT_TOLERANCE_MILLI = 200;

export interface SquadValue {
  coverage: number;
  mustCover: number;
  duplicates: number;
  hops: number;
  total: number;
}

/** Squad value V: coverage, must-cover, unplanned duplicates and impossible hops. */
export function squadValue(
  input: Pick<SolverInput, 'charter' | 'catalog' | 'venueGraph'>,
  manifests: readonly Manifest[],
): SquadValue {
  const { charter } = input;
  const report = analyseCoverage({ ...input, manifests });
  const topics = new Map(charter.topics.map((t) => [t.id, t]));
  let coverage = 0;
  for (const cell of report.cells) {
    const weight = topics.get(cell.topicId)?.weight ?? 0;
    coverage += Math.floor((weight * 1000 * Math.min(cell.count, cell.target)) / cell.target);
  }
  const mustCover = MUST_COVER_VALUE * ((charter.mustCover?.length ?? 0) - report.gaps.length);
  // `0 -` rather than a unary minus, so an empty count gives +0 and never -0.
  const duplicates = 0 - DUPLICATE_PENALTY * report.duplicates.filter((d) => !d.planned).length;
  const hops = 0 - HOP_PENALTY * report.hops.length;
  return { coverage, mustCover, duplicates, hops, total: coverage + mustCover + duplicates + hops };
}

/** Personal value P: priority times 200 for each session the member holds. */
export function personalValue(manifest: Manifest): number {
  return heldSessions(manifest).reduce((sum, s) => sum + priorityOf(s) * PRIORITY_UNIT, 0);
}

interface Move {
  kind: 'SWAP' | 'CLAIM' | 'DROP';
  memberId: string;
  add: string[];
  remove: string[];
  differences?: DifferenceField[];
}

interface Assessment {
  squadDelta: number;
  personalDelta: number;
  parts: SquadValue;
  accepted: boolean;
  after: Manifest[];
  valueAfter: SquadValue;
}

const moveKey = (m: Move): string =>
  `${m.kind}|${m.memberId}|${m.add.join(',')}|${m.remove.join(',')}`;

function applyMove(
  manifests: readonly Manifest[],
  move: Move,
  ctx: FeasibilityContext,
): Manifest[] {
  return manifests.map((m) => {
    if (m.memberId !== move.memberId) return m;
    const removed = m.sessions.filter((s) => move.remove.includes(s.sessionId));
    const kept = m.sessions.filter((s) => !move.remove.includes(s.sessionId));
    const inherited = removed[0];
    const added: ManifestSession[] = move.add.flatMap((id) => {
      const session = ctx.index.get(id);
      if (!session) return [];
      return [
        {
          sessionId: id,
          code: session.code,
          status: inherited?.status ?? 'favorite',
          ...(inherited?.priority !== undefined && { priority: inherited.priority }),
        },
      ];
    });
    return { ...m, sessions: [...kept, ...added] };
  });
}

/**
 * The hard constraints of a move against `state`. Returns the manifest and the sessions it would
 * remove, or undefined when a locked or pinned session would move, a declined one would be added,
 * or an addition does not fit the member's day.
 */
function hardCheck(
  ctx: FeasibilityContext,
  state: readonly Manifest[],
  move: Move,
): { manifest: Manifest; removed: ManifestSession[] } | undefined {
  const manifest = state.find((m) => m.memberId === move.memberId);
  if (!manifest) return undefined;
  const held = heldSessions(manifest);
  const holds = manifest.holds ?? [];

  const mustCover = new Set((ctx.charter.mustCover ?? []).map((x) => x.sessionId));
  const removed: ManifestSession[] = [];
  for (const id of move.remove) {
    const s = held.find((x) => x.sessionId === id);
    if (!s || isLocked(s)) return undefined;
    if (holds.some((h) => h.sessionId === id && h.reason === 'pinned')) return undefined;
    // A must-cover session is named by the squad. Giving it up, even for its own repeat, would
    // only make the solver ask for it back, so the sole holder keeps it.
    if (
      mustCover.has(id) &&
      !state.some(
        (m) =>
          m.memberId !== move.memberId && heldSessions(m).some((other) => other.sessionId === id),
      )
    ) {
      return undefined;
    }
    removed.push(s);
  }

  let schedule = held
    .filter((s) => !move.remove.includes(s.sessionId))
    .flatMap((s) => {
      const session = ctx.index.get(s.sessionId);
      return session ? [session] : [];
    });
  for (const id of move.add) {
    const session = ctx.index.get(id);
    if (!session) return undefined;
    if (holds.some((h) => h.sessionId === id && h.reason === 'declined')) return undefined;
    if (manifest.sessions.some((s) => s.sessionId === id)) return undefined;
    if (!canAdd(ctx, schedule, session)) return undefined;
    schedule = [...schedule, session];
  }
  return { manifest, removed };
}

/**
 * Can this move be made against `state`, and what does it do? Undefined when it breaks a hard
 * constraint (see `hardCheck`). `accepted` applies the value thresholds.
 */
function assess(
  ctx: FeasibilityContext,
  state: readonly Manifest[],
  valueNow: SquadValue,
  move: Move,
): Assessment | undefined {
  const checked = hardCheck(ctx, state, move);
  if (!checked) return undefined;
  const { manifest, removed } = checked;

  const after = applyMove(state, move, ctx);
  const valueAfter = squadValue(ctx, after);
  const squadDelta = valueAfter.total - valueNow.total;

  const inheritedPriority = removed[0] ? priorityOf(removed[0]) : DEFAULT_PRIORITY;
  const personalDelta =
    move.add.length * inheritedPriority * PRIORITY_UNIT -
    removed.reduce((sum, s) => sum + priorityOf(s) * PRIORITY_UNIT, 0);

  const toleranceMilli =
    ctx.charter.tolerance === undefined
      ? DEFAULT_TOLERANCE_MILLI
      : Math.round(ctx.charter.tolerance * 1000);
  const allowedLoss = Math.floor((toleranceMilli * personalValue(manifest)) / 1000);

  const parts: SquadValue = {
    coverage: valueAfter.coverage - valueNow.coverage,
    mustCover: valueAfter.mustCover - valueNow.mustCover,
    duplicates: valueAfter.duplicates - valueNow.duplicates,
    hops: valueAfter.hops - valueNow.hops,
    total: squadDelta,
  };
  return {
    squadDelta,
    personalDelta,
    parts,
    // No component of V may fall. Trading a must-cover session for coverage elsewhere would
    // make the solver ask to claim a session and then to give it up (a deviation from docs/03,
    // which only asks for a total gain; see the addendum).
    accepted:
      squadDelta >= MIN_SQUAD_GAIN &&
      parts.coverage >= 0 &&
      parts.mustCover >= 0 &&
      parts.duplicates >= 0 &&
      parts.hops >= 0 &&
      personalDelta >= -allowedLoss,
    after,
    valueAfter,
  };
}

function latestPerMember(manifests: readonly Manifest[]): Manifest[] {
  const latest = new Map<string, Manifest>();
  for (const m of manifests) {
    const current = latest.get(m.memberId);
    if (
      !current ||
      m.seq > current.seq ||
      (m.seq === current.seq && canonicalJson(m) < canonicalJson(current))
    ) {
      latest.set(m.memberId, m);
    }
  }
  return [...latest.values()].sort((a, b) => compareStrings(a.memberId, b.memberId));
}

function generateMoves(
  ctx: FeasibilityContext,
  input: SolverInput,
  manifests: readonly Manifest[],
): Move[] {
  const moves: Move[] = [];
  const analysis = findRepeatGroups(input.catalog.sessions);
  const holders = new Map<string, string[]>();
  for (const m of manifests) {
    for (const s of heldSessions(m)) {
      holders.set(s.sessionId, [...(holders.get(s.sessionId) ?? []), m.memberId]);
    }
  }

  // SWAP: move to another session of the same repeat group.
  for (const m of manifests) {
    for (const s of heldSessions(m)) {
      const group = groupOf(analysis, s.sessionId);
      if (!group) continue;
      for (const id of group.sessionIds) {
        if (id === s.sessionId) continue;
        moves.push({
          kind: 'SWAP',
          memberId: m.memberId,
          add: [id],
          remove: [s.sessionId],
          differences: group.differences,
        });
      }
    }
  }

  // DROP: release a session that more members hold than the topic target asks for.
  for (const [sessionId, ids] of holders) {
    const session = ctx.index.get(sessionId);
    if (!session || ids.length <= targetOf(session, input.charter)) continue;
    for (const memberId of ids)
      moves.push({ kind: 'DROP', memberId, add: [], remove: [sessionId] });
  }

  // CLAIM: an uncovered must-cover or new session goes to its owner under the claim rule.
  const wanted = new Set([
    ...(input.charter.mustCover ?? []).map((x) => x.sessionId),
    ...(input.newSessions ?? []),
  ]);
  for (const sessionId of [...wanted].sort(compareStrings)) {
    if (holders.has(sessionId) || !ctx.index.has(sessionId)) continue;
    const owner = rankClaimants({ ...input, manifests }, sessionId)[0];
    if (owner)
      moves.push({ kind: 'CLAIM', memberId: owner.memberId, add: [sessionId], remove: [] });
  }
  return moves;
}

function reasonsFor(move: Move, parts: SquadValue): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (move.kind === 'SWAP') reasons.push('repeat-available');
  if (move.kind === 'CLAIM') reasons.push('owner-by-claim-rule');
  if (parts.mustCover > 0) reasons.push('covers-must-cover');
  if (parts.coverage > 0) reasons.push('raises-coverage');
  if (parts.duplicates > 0) reasons.push('removes-duplicate');
  if (parts.hops > 0) reasons.push('fixes-connection');
  return reasons;
}

function toProposal(move: Move, a: Assessment, provisional: boolean): Proposal {
  const body = {
    kind: move.kind,
    memberId: move.memberId,
    ...(move.add.length > 0 && { add: move.add }),
    ...(move.remove.length > 0 && { remove: move.remove }),
    squadDelta: a.squadDelta,
    personalDelta: a.personalDelta,
    reasons: reasonsFor(move, a.parts),
    ...(move.differences !== undefined && { differences: move.differences }),
    provisional,
  };
  return { id: sha256Hex(canonicalJson(body)), ...body };
}

/**
 * Proposes moves that raise the squad's value. Every candidate is feasible and accepted against
 * the current schedules (squad gain of at least 50 and a personal loss within the tolerance), then
 * ranked by (-squad delta, -personal delta, canonical move). Taking them in that order, a candidate
 * is kept only if it is still feasible and worthwhile once the earlier ones are applied, so
 * proposals never contradict each other. At most 50 are returned.
 */
export function propose(input: SolverInput): Proposal[] {
  const manifests = latestPerMember(input.manifests);
  const ctx = makeContext(input.charter, input.catalog, input.venueGraph);
  const provisional = new Set(manifests.map((m) => m.catalogHash)).size > 1;
  const baseValue = squadValue(ctx, manifests);

  const ranked: { move: Move; first: Assessment }[] = [];
  for (const move of generateMoves(ctx, input, manifests)) {
    const first = assess(ctx, manifests, baseValue, move);
    if (first?.accepted) ranked.push({ move, first });
  }
  ranked.sort(
    (a, b) =>
      b.first.squadDelta - a.first.squadDelta ||
      b.first.personalDelta - a.first.personalDelta ||
      compareStrings(moveKey(a.move), moveKey(b.move)),
  );

  const proposals: Proposal[] = [];
  const chosen: Move[] = [];
  let state: readonly Manifest[] = manifests;
  let value = baseValue;
  for (const { move, first } of ranked) {
    if (proposals.length >= MAX_PROPOSALS) break;
    // Still worthwhile once the earlier proposals are applied...
    const now = assess(ctx, state, value, move);
    if (!now?.accepted) continue;
    // ...and it must not take away what an earlier proposal needs. Each proposal has to stand
    // alone, whichever order a member accepts them in.
    const alone = applyMove(manifests, move, ctx);
    if (chosen.some((earlier) => hardCheck(ctx, alone, earlier) === undefined)) continue;
    proposals.push(toProposal(move, first, provisional));
    chosen.push(move);
    state = now.after;
    value = now.valueAfter;
  }
  return proposals;
}

/** Applies a proposal to a set of manifests, as the member's accepted change would. Used by tests and the UI preview. */
export function applyProposal(
  input: Pick<SolverInput, 'charter' | 'catalog' | 'venueGraph'>,
  manifests: readonly Manifest[],
  proposal: Proposal,
): Manifest[] {
  const ctx = makeContext(input.charter, input.catalog, input.venueGraph);
  const kind = proposal.kind;
  if (kind === 'MEET') return [...manifests];
  return applyMove(
    manifests,
    { kind, memberId: proposal.memberId, add: proposal.add ?? [], remove: proposal.remove ?? [] },
    ctx,
  );
}
