import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { propose, type Proposal } from '../src/solver';
import { applyOne, buildWorld, heldOf, lookup, problem, shuffled, value } from './world';

// Property tests for docs/03: determinism, feasibility, locked and pinned sessions never move,
// declined sessions are never added, every proposal gains value, and the proposals stand alone.
// The rules are re-implemented independently in world.ts.

const tapeArb = fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
  minLength: 300,
  maxLength: 300,
});
const RUNS = { numRuns: 200 };

describe('solver properties', () => {
  it('is deterministic and independent of the order manifests and sessions arrive in', () => {
    fc.assert(
      fc.property(tapeArb, fc.integer({ min: 1, max: 10_000 }), (tape, seed) => {
        const w = buildWorld(tape);
        const base = propose(w);
        const reordered = propose({
          ...w,
          manifests: shuffled(w.manifests, seed),
          catalog: { ...w.catalog, sessions: shuffled(w.catalog.sessions, seed + 1) },
        });
        expect(reordered).toEqual(base);
        expect(propose(w)).toEqual(base);
      }),
      RUNS,
    );
  });

  it('never moves a locked, speaker or pinned session, and never adds a declined one', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        for (const p of propose(w)) {
          const m = w.manifests.find((x) => x.memberId === p.memberId)!;
          for (const id of p.remove ?? []) {
            const s = m.sessions.find((x) => x.sessionId === id)!;
            expect(s.locked === true || s.role === 'speaker', `locked ${id}`).toBe(false);
            expect(
              m.holds?.some((h) => h.sessionId === id && h.reason === 'pinned'),
              `pinned ${id}`,
            ).toBeFalsy();
          }
          for (const id of p.add ?? []) {
            expect(
              m.holds?.some((h) => h.sessionId === id && h.reason === 'declined'),
              `declined ${id}`,
            ).toBeFalsy();
          }
        }
      }),
      RUNS,
    );
  });

  it('only proposes what fits: no overlap, walking plus buffer, day cap, lunch, not full', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        for (const p of propose(w)) expect(problem(w, w.manifests, p)).toBeUndefined();
      }),
      RUNS,
    );
  });

  it('gains at least 50 for the squad, and the delta matches an independent recomputation', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        const index = lookup(w);
        const before = value(w, w.manifests);
        for (const p of propose(w)) {
          expect(p.squadDelta).toBeGreaterThanOrEqual(50);
          expect(value(w, applyOne(w.manifests, p, index)) - before).toBe(p.squadDelta);
          expect(p.reasons.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it('keeps each member personal loss within their tolerance', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        const milli = Math.round((w.charter.tolerance ?? 0.2) * 1000);
        for (const p of propose(w)) {
          const m = w.manifests.find((x) => x.memberId === p.memberId)!;
          const personal = heldOf(m).reduce((sum, s) => sum + (s.priority ?? 3) * 200, 0);
          expect(p.personalDelta).toBeGreaterThanOrEqual(-Math.floor((milli * personal) / 1000));
        }
      }),
      RUNS,
    );
  });

  it('proposals stand alone: accepting any one leaves every other still doable', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        const index = lookup(w);
        const proposals = propose(w);
        for (const p of proposals) {
          const after = applyOne(w.manifests, p, index);
          for (const q of proposals) {
            if (q.id === p.id) continue;
            expect(problem(w, after, q), `${q.kind} after ${p.kind}`).toBeUndefined();
          }
        }
      }),
      RUNS,
    );
  });

  it('is stable when re-run with the moves applied: nothing repeats, value rises, and it settles', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        const index = lookup(w);
        let manifests = w.manifests;
        const done = new Set<string>();
        for (let round = 0; round < 25; round++) {
          const proposals = propose({ ...w, manifests });
          if (proposals.length === 0) return;
          const before = value(w, manifests);
          for (const p of proposals) {
            const key = `${p.kind}|${p.memberId}|${p.add}|${p.remove}`;
            expect(done.has(key), `repeated ${key}`).toBe(false);
            done.add(key);
            manifests = applyOne(manifests, p, index);
          }
          expect(value(w, manifests)).toBeGreaterThan(before);
        }
        throw new Error('did not settle in 25 rounds');
      }),
      { numRuns: 100 },
    );
  });

  it('returns at most 50 proposals, in decreasing squad delta, with unique ids', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const proposals = propose(buildWorld(tape));
        expect(proposals.length).toBeLessThanOrEqual(50);
        expect(new Set(proposals.map((p) => p.id)).size).toBe(proposals.length);
        for (let k = 1; k < proposals.length; k++) {
          expect((proposals[k] as Proposal).squadDelta).toBeLessThanOrEqual(
            (proposals[k - 1] as Proposal).squadDelta,
          );
        }
      }),
      RUNS,
    );
  });

  it('marks proposals provisional exactly when the catalog hashes differ', () => {
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const w = buildWorld(tape);
        const differ = new Set(w.manifests.map((m) => m.catalogHash)).size > 1;
        for (const p of propose(w)) expect(p.provisional).toBe(differ);
      }),
      RUNS,
    );
  });

  it('generates worlds that actually produce proposals (the properties are not vacuous)', () => {
    let withProposals = 0;
    const kinds = new Set<string>();
    fc.assert(
      fc.property(tapeArb, (tape) => {
        const proposals = propose(buildWorld(tape));
        if (proposals.length > 0) withProposals += 1;
        for (const p of proposals) kinds.add(p.kind);
      }),
      { numRuns: 300 },
    );
    expect(withProposals).toBeGreaterThan(30);
    expect(kinds.has('SWAP')).toBe(true);
    expect(kinds.has('CLAIM')).toBe(true);
  });
});
