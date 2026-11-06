import {
  applyProposal,
  buildSquadView,
  catalogSnapshotSchema,
  charterSchema,
  defaultVenueGraph,
  manifestSchema,
  type Charter,
  type CatalogSnapshot,
  type Manifest,
  type Proposal,
} from '@junction/core';
import squadJson from '../../../../fixtures/demo/squad.json';
import snapshotJson from '../../../../fixtures/demo/snapshot.json';
import {
  SourceError,
  type ActionResult,
  type AppState,
  type DataSource,
  type SessionResult,
} from './types';

// The hosted demo. Everything is computed in this tab from invented fixtures: no fetch, no
// storage, no sign-in. Accepting a proposal changes an in-memory copy and rebuilds the view with
// the same pure functions the real agent uses.

export interface DemoInput {
  charter: Charter;
  manifests: Manifest[];
  snapshot: CatalogSnapshot;
}

export function loadDemoInput(): DemoInput {
  const raw = squadJson as { charter: unknown; manifests: unknown[] };
  return {
    charter: charterSchema.parse(raw.charter),
    manifests: raw.manifests.map((m) => manifestSchema.parse(m)),
    snapshot: catalogSnapshotSchema.parse(snapshotJson),
  };
}

function sessionResults(
  proposal: Proposal,
  codeOf: (id: string) => string,
  undo: boolean,
): SessionResult[] {
  const adds = (undo ? proposal.remove : proposal.add) ?? [];
  const removes = (undo ? proposal.add : proposal.remove) ?? [];
  return [
    ...adds.map((id) => ({
      sessionId: id,
      code: codeOf(id),
      action: 'add' as const,
      ok: true,
      detail: 'Demo only, nothing was sent.',
    })),
    ...removes.map((id) => ({
      sessionId: id,
      code: codeOf(id),
      action: 'remove' as const,
      ok: true,
      detail: 'Demo only, nothing was sent.',
    })),
  ];
}

export function createDemoSource(input: DemoInput = loadDemoInput()): DataSource {
  const { charter, snapshot } = input;
  const me = charter.leader;
  const meName = charter.members.find((m) => m.memberId === me)?.name ?? 'you';
  let manifests = [...input.manifests];
  const declined = new Set<string>();
  const accepted = new Map<string, { before: Manifest[]; proposal: Proposal }>();
  const codes = new Map(snapshot.sessions.map((s) => [s.sessionId, s.code]));
  const codeOf = (id: string) => codes.get(id) ?? id;

  function state(): AppState {
    const view = buildSquadView({
      charter,
      manifests,
      catalog: snapshot,
      venueGraph: defaultVenueGraph,
      me,
    });
    view.proposals = view.proposals.filter((p) => !declined.has(p.id));
    return {
      signedIn: true,
      member: { memberId: me, name: meName },
      squad: view,
      lastSync: null,
      catalog: { count: snapshot.sessions.length, fetchedAt: 'demo' },
    };
  }

  const settle = <T>(value: T): Promise<T> => Promise.resolve(value);
  const notInDemo = (what: string) =>
    Promise.reject(
      new SourceError(
        'demo',
        `${what} works in the app you run on your own machine, not in this demo.`,
      ),
    );

  return {
    mode: 'demo',
    getState: () => settle(state()),
    sync: () => settle(state()),
    accept: (id): Promise<ActionResult> => {
      const proposal = state().squad?.proposals.find((p) => p.id === id);
      if (!proposal)
        return Promise.reject(
          new SourceError('gone', 'That proposal no longer applies. The list below is current.'),
        );
      if (proposal.memberId !== me)
        return Promise.reject(
          new SourceError('not-yours', 'Only the person it is meant for can accept this proposal.'),
        );
      accepted.set(id, { before: manifests, proposal });
      manifests = applyProposal(
        { charter, catalog: snapshot, venueGraph: defaultVenueGraph },
        manifests,
        proposal,
      );
      return settle({ results: sessionResults(proposal, codeOf, false), state: state() });
    },
    decline: (id) => {
      declined.add(id);
      return settle(state());
    },
    undo: (id): Promise<ActionResult> => {
      const entry = accepted.get(id);
      if (!entry)
        return Promise.reject(
          new SourceError('gone', 'There is nothing to undo for that proposal.'),
        );
      manifests = entry.before;
      accepted.delete(id);
      return settle({ results: sessionResults(entry.proposal, codeOf, true), state: state() });
    },
    login: () => notInDemo('Signing in'),
    logout: () => notInDemo('Signing out'),
    exportPicks: () => notInDemo('Sharing your picks'),
    importPicks: () => notInDemo('Adding picks from your squad'),
  };
}
