import { describe, expect, it } from 'vitest';
import { buildSquadView, defaultVenueGraph } from '@junction/core';
import { loadDemoInput } from '../data/demo';
import { attendeesOf, dayModel, initialDay } from './model';

const input = loadDemoInput();
const view = buildSquadView({
  charter: input.charter,
  manifests: input.manifests,
  catalog: input.snapshot,
  venueGraph: defaultVenueGraph,
  me: input.charter.leader,
});
const tuesday = view.days[1]!.day;
const model = dayModel(view, tuesday);
const name = (id: string) => view.members.find((m) => m.memberId === id)?.name;

describe('dayModel on the demo Tuesday', () => {
  it('opens on the first day with issues', () => {
    expect(initialDay(view)).toBe(tuesday);
    expect(initialDay(view, view.days[3]!.day)).toBe(view.days[3]!.day);
  });

  it('gives each member their sessions in time order', () => {
    const counts = Object.fromEntries(model.runs.map((r) => [r.member.name, r.sessions.length]));
    expect(counts).toEqual({ Ana: 4, Luis: 4, Marta: 3, Diego: 3, Sofía: 2 });
    for (const r of model.runs)
      for (let i = 1; i < r.sessions.length; i++)
        expect(r.sessions[i]!.startLocal).toBeGreaterThanOrEqual(r.sessions[i - 1]!.startLocal);
  });

  it('finds the impossible walk for Luis', () => {
    expect(model.hops).toHaveLength(1);
    const luis = model.runs.find((r) => r.member.name === 'Luis')!;
    const bad = luis.hops.filter((h) => h.impossible);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.impossible).toMatchObject({ needMin: 28, haveMin: 15 });
    expect(bad[0]!.walkMin).toBe(28);
  });

  it('marks one planned overlap and one duplicate', () => {
    expect(model.shared.map((s) => [s.session.code, s.planned])).toEqual([
      ['AGT301', true],
      ['OPS305-R', false],
    ]);
    expect(model.unplanned).toBe(1);
    expect(attendeesOf(model, model.shared[1]!.session.sessionId).map((m) => m.name)).toEqual(['Ana', 'Luis']);
  });

  it('shows what nobody covers, with the claimant for a claimable session', () => {
    const open = Object.fromEntries(
      model.open.map((o) => [o.session.code, { owner: o.owner?.name, lunch: o.collidesWithLunch }]),
    );
    expect(open).toEqual({
      SEC301: { owner: undefined, lunch: true },
      BSI403: { owner: 'Sofía', lunch: false },
    });
  });

  it('leaves a quiet day quiet', () => {
    const monday = dayModel(view, view.days[0]!.day);
    expect(monday.hops).toHaveLength(0);
    expect(monday.unplanned).toBe(0);
    expect(name(view.me ?? '')).toBe('Ana');
  });
});
