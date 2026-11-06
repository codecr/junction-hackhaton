import { describe, expect, it } from 'vitest';
import { applyProposal, reinvent2026VenueGraph, propose, rankClaimants } from '@junction/core';
import { generateDemo } from './generate';

// The solver on the demo squad must tell the story of design/reference.html.
const demo = generateDemo();
const input = {
  charter: demo.charter,
  manifests: demo.manifests,
  catalog: demo.snapshot,
  venueGraph: reinvent2026VenueGraph,
};
const name = (id: string) => demo.members.find((m) => m.memberId === id)?.name;
const codeOf = (id: string) => demo.snapshot.sessions.find((s) => s.sessionId === id)?.code;
const proposals = propose(input);

describe('the solver on the reference squad', () => {
  it('proposes exactly two things: the OPS305-R1 swap and the BSI403 claim', () => {
    expect(proposals.map((p) => p.kind).sort()).toEqual(['CLAIM', 'SWAP']);
  });

  it('asks Ana to take OPS305-R1 on Wednesday instead, since Luis keeps the Tuesday session', () => {
    const swap = proposals.find((p) => p.kind === 'SWAP')!;
    expect(name(swap.memberId)).toBe('Ana');
    expect(swap.remove?.map(codeOf)).toEqual(['OPS305-R']);
    expect(swap.add?.map(codeOf)).toEqual(['OPS305-R1']);
    expect(swap).toMatchObject({ squadDelta: 500, personalDelta: 0 });
    expect(swap.reasons).toEqual(['repeat-available', 'removes-duplicate']);
    // The UI shows these before the swap is accepted: the repeat has another format and time.
    expect(swap.differences).toEqual(['features', 'start']);
  });

  it('asks Sofía to claim the new session BSI403, and not the lunch session SEC301', () => {
    const claim = proposals.find((p) => p.kind === 'CLAIM')!;
    expect(name(claim.memberId)).toBe('Sofía');
    expect(claim.add?.map(codeOf)).toEqual(['BSI403']);
    expect(claim.reasons).toEqual(['owner-by-claim-rule', 'covers-must-cover']);
    expect(proposals.flatMap((p) => p.add ?? []).includes('demo-sec301')).toBe(false);
  });

  it('shows the claim ranking the reference describes: Sofía is free and has no agentic session yet', () => {
    const ranks = rankClaimants(input, 'demo-bsi403').map((r) => name(r.memberId));
    // Ana and Marta cannot make it. Luis can walk from Caesars Palace in time and ranks last
    // under the claim rule.
    expect(ranks).toEqual(['Sofía', 'Diego', 'Luis']);
  });

  it("marks both as provisional, because Marta's catalog is one update behind", () => {
    expect(proposals.every((p) => p.provisional)).toBe(true);
  });

  it('settles after the two proposals are accepted: nothing else to propose', () => {
    let manifests = demo.manifests;
    for (const p of proposals) manifests = applyProposal(input, manifests, p);
    expect(propose({ ...input, manifests })).toEqual([]);
  });

  it('is fast enough to run on every sync', () => {
    const start = performance.now();
    propose(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
