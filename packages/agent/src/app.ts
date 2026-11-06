import {
  buildSquadView,
  defaultVenueGraph,
  formatInstant,
  sessionCodeSchema,
  sha256Hex,
  signMessage,
  venueGraphSchema,
  type Charter,
  type Manifest,
  type ManifestSession,
  type SquadView,
  type VenueGraph,
} from '@junction/core';
import { join } from 'node:path';
import { login as runLogin, logout as runLogout, TokenProvider } from './auth';
import {
  SqliteCatalogStore,
  utcOffsetMinutes,
  type CatalogDiff,
  type CatalogStore,
} from './catalog-store';
import { ApiError, EventsClient, type PersonalTime, type Schedule } from './events-client';
import { junctionHome, readJson, writeJson } from './paths';
import {
  ensureIdentity,
  loadCharter,
  loadIdentity,
  loadLocal,
  loadManifests,
  saveLocal,
  storeManifestEnvelope,
  type Identity,
  type LocalSquad,
} from './squad';

// The agent's use cases, shared by the CLI, the local web server and the MCP server. Every write to
// the attendee's schedule is confirmed from GetSchedule and reported per session (rules 4 and 5).

export const EVENT_ID = 'reinvent2026';
const HOLD_TTL_MS = 24 * 3600_000;
const nowIso = () => formatInstant(Math.floor(Date.now() / 1000));

export interface SessionResult {
  sessionId: string;
  code: string;
  action: 'add' | 'remove';
  ok: boolean;
  detail: string;
}

export interface AgentState {
  signedIn: boolean;
  member: { memberId: string; name: string } | null;
  squad: SquadView | null;
  lastSync: string | null;
  catalog: { count: number; fetchedAt: string } | null;
}

interface SyncMeta {
  lastSync?: string;
  lastDiff?: CatalogDiff;
}

const metaFile = () => join(junctionHome(), 'sync.json');

export interface JunctionOptions {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
}

export class Junction {
  readonly tokens: TokenProvider;
  readonly api: EventsClient;
  private storeInstance: CatalogStore | undefined;

  constructor(private readonly opts: JunctionOptions = {}) {
    const fetchFn = opts.fetch ?? fetch;
    this.tokens = new TokenProvider(fetchFn);
    this.api = new EventsClient({ getToken: (force) => this.tokens.get(force), fetch: fetchFn });
  }

  get store(): CatalogStore {
    this.storeInstance ??= new SqliteCatalogStore();
    return this.storeInstance;
  }

  venueGraph(): VenueGraph {
    const custom = venueGraphSchema.safeParse(readJson(join(junctionHome(), 'venues.json')));
    return custom.success ? custom.data : defaultVenueGraph;
  }

  // -- Sign-in ---------------------------------------------------------------------------------

  async login(onUrl?: (url: string, port: number) => void): Promise<void> {
    await runLogin({
      openBrowser: this.opts.openBrowser ?? (() => undefined),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(onUrl ? { onUrl } : {}),
    });
  }

  logout() {
    return runLogout(this.opts.fetch);
  }

  // -- Catalog ---------------------------------------------------------------------------------

  async refreshCatalog(
    onPage?: (n: number, total: number | undefined) => void,
  ): Promise<{ count: number; totalCount: number | undefined; pages: number; diff: CatalogDiff }> {
    const event = await this.api.getEvent(EVENT_ID);
    const timezone = event.timezone ?? 'America/Los_Angeles';
    const at = event.startDate ? new Date(event.startDate) : new Date();
    const { items, totalCount, pages } = await this.api.listAllSessions(EVENT_ID, onPage);
    const diff = this.store.saveRaw(
      {
        eventId: EVENT_ID,
        timezone,
        utcOffsetMin: utcOffsetMinutes(timezone, at),
        fetchedAt: nowIso(),
        totalCount,
        pages,
      },
      items,
    );
    const meta = readJson<SyncMeta>(metaFile()) ?? {};
    writeJson(metaFile(), { ...meta, lastDiff: diff });
    return { count: items.length, totalCount, pages, diff };
  }

  private requireSnapshot() {
    const snap = this.store.snapshot(this.venueGraph());
    if (!snap)
      throw new Error(
        'No catalog on this machine yet. Run `junction sync` (or `junction catalog refresh`) after signing in.',
      );
    return snap;
  }

  // -- Squad and picks -------------------------------------------------------------------------

  identity(name?: string): Identity {
    return ensureIdentity(name);
  }

  private requireCharter(): Charter {
    const charter = loadCharter();
    if (!charter)
      throw new Error(
        'You are not in a squad yet. Create one with `junction squad create`, or import an invite block with `junction squad import`.',
      );
    return charter;
  }

  /** Builds and signs this member's picks from GetSchedule. Never includes titles or rooms. */
  buildManifest(schedule: Schedule): Manifest {
    const me = ensureIdentity();
    const charter = this.requireCharter();
    const { snapshot, hash } = this.requireSnapshot();
    const local = loadLocal();
    const codes = new Map(snapshot.sessions.map((s) => [s.sessionId, s.code]));
    const codeOf = (id: string): string | undefined => {
      const known = codes.get(id);
      if (known) return known;
      const raw = this.store.raw(id)?.abbreviation;
      return typeof raw === 'string' && sessionCodeSchema.safeParse(raw).success ? raw : undefined;
    };
    const sessions: ManifestSession[] = [];
    const add = (sessionId: string, status: 'reserved' | 'favorite') => {
      if (sessions.some((s) => s.sessionId === sessionId)) return;
      const code = codeOf(sessionId);
      if (!code) return;
      const priority = local.priorities[sessionId];
      sessions.push({ sessionId, code, status, ...(priority ? { priority } : {}) });
    };
    for (const id of schedule.reserved) add(id, 'reserved');
    for (const id of schedule.favorites) add(id, 'favorite');
    const cutoff = Date.now() - HOLD_TTL_MS;
    const holds = local.holds
      .filter((h) => Date.parse(h.at) >= cutoff)
      .map(({ sessionId, reason }) => ({ sessionId, reason }));
    const seq = local.seq + 1;
    saveLocal({ ...local, seq, holds: local.holds.filter((h) => Date.parse(h.at) >= cutoff) });
    return {
      v: 1,
      type: 'manifest',
      squadId: charter.squadId,
      memberId: me.memberId,
      seq,
      issuedAt: nowIso(),
      eventId: charter.eventId,
      catalogHash: hash,
      share: local.share,
      sessions: sessions.slice(0, 200),
      ...(holds.length ? { holds: holds.slice(0, 200) } : {}),
    };
  }

  /** GetSchedule, sign the picks, store them, and (when configured) exchange through the squad server. */
  async sync(options: { refreshCatalog?: boolean } = {}): Promise<AgentState> {
    if (options.refreshCatalog || !this.store.meta()) await this.refreshCatalog();
    this.requireCharter();
    const schedule = await this.api.getSchedule(EVENT_ID);
    await this.publishManifest(schedule);
    const meta = readJson<SyncMeta>(metaFile()) ?? {};
    writeJson(metaFile(), { ...meta, lastSync: nowIso() });
    return this.state();
  }

  private async publishManifest(schedule: Schedule): Promise<void> {
    const me = ensureIdentity();
    const manifest = this.buildManifest(schedule);
    const env = signMessage(manifest, me.memberId, me.secretKey);
    storeManifestEnvelope(me.memberId, env);
    if (this.relaySync) await this.relaySync(env);
  }

  /** Set by the squad server transport when one is configured. */
  relaySync: ((myManifest: ReturnType<typeof signMessage>) => Promise<void>) | undefined;

  view(): SquadView | null {
    const charter = loadCharter();
    if (!charter) return null;
    const snap = this.store.snapshot(this.venueGraph());
    if (!snap) return null;
    const meta = readJson<SyncMeta>(metaFile()) ?? {};
    const me = loadIdentity();
    const held = new Set(loadManifests(charter).flatMap((m) => m.sessions.map((s) => s.sessionId)));
    const newSessions = (meta.lastDiff?.added ?? []).filter((id) => !held.has(id));
    return buildSquadView({
      charter,
      manifests: loadManifests(charter),
      catalog: snap.snapshot,
      venueGraph: this.venueGraph(),
      ...(me ? { me: me.memberId } : {}),
      ...(newSessions.length ? { newSessions } : {}),
    });
  }

  state(): AgentState {
    const me = loadIdentity();
    const meta = readJson<SyncMeta>(metaFile()) ?? {};
    const catalog = this.store.meta();
    return {
      signedIn: this.tokens.signedIn(),
      member: me ? { memberId: me.memberId, name: me.name } : null,
      squad: this.view(),
      lastSync: meta.lastSync ?? null,
      catalog: catalog ? { count: this.store.allRaw().length, fetchedAt: catalog.fetchedAt } : null,
    };
  }

  // -- Proposals -------------------------------------------------------------------------------

  private findMine(proposalId: string) {
    const view = this.view();
    const me = loadIdentity();
    const p = view?.proposals.find((x) => x.id === proposalId || x.id.startsWith(proposalId));
    if (!view || !p)
      throw new Error(
        'That proposal is no longer current. Run `junction sync` and list proposals again.',
      );
    if (!me || p.memberId !== me.memberId) {
      const who = view.members.find((m) => m.memberId === p.memberId)?.name ?? p.memberId;
      throw new Error(
        `That proposal is for ${who}. Only they can accept it on their own schedule.`,
      );
    }
    return { view, p };
  }

  /**
   * Applies a proposal to the signed-in member's own schedule. Adds go first and removes only run
   * if every add held, so a swap never leaves the member with neither session.
   */
  async accept(
    proposalId: string,
    opts: { reserve?: boolean } = {},
  ): Promise<{ results: SessionResult[]; state: AgentState }> {
    const { view, p } = this.findMine(proposalId);
    const codeOf = (id: string) => view.sessions[id]?.code ?? id;
    const before = await this.api.getSchedule(EVENT_ID);
    const notes = new Map<string, string>();

    const adds = p.add ?? [];
    const removes = p.remove ?? [];
    let addsOk = true;
    if (adds.length) {
      try {
        const res = opts.reserve
          ? await this.api.reserveSessions(EVENT_ID, adds)
          : await this.api.associateFavorites(EVENT_ID, adds);
        for (const f of res.failed) {
          notes.set(f.sessionId, failureText(f.code, f.conflictsWith?.map(codeOf)));
          if (f.code !== 'alreadyFavorited' && f.code !== 'alreadyScheduled') addsOk = false;
        }
      } catch (e) {
        addsOk = false;
        for (const id of adds) notes.set(id, errorText(e));
      }
    }
    // Reconcile before anything else (rule 4): what actually happened?
    const mid = await this.api.getSchedule(EVENT_ID);
    const has = (s: Schedule, id: string) => s.reserved.includes(id) || s.favorites.includes(id);
    if (adds.some((id) => !has(mid, id))) addsOk = false;

    if (addsOk) {
      for (const id of removes) {
        try {
          if (mid.reserved.includes(id)) await this.api.cancelReservation(EVENT_ID, id);
          if (mid.favorites.includes(id)) await this.api.disassociateFavorite(EVENT_ID, id);
        } catch (e) {
          notes.set(id, errorText(e));
        }
      }
    } else {
      for (const id of removes) notes.set(id, 'Kept, because the new session could not be added.');
    }

    const after = await this.api.getSchedule(EVENT_ID);
    const results: SessionResult[] = [
      ...adds.map((id) => ({
        sessionId: id,
        code: codeOf(id),
        action: 'add' as const,
        ok: has(after, id),
        detail: has(after, id)
          ? after.reserved.includes(id)
            ? 'Reserved.'
            : 'Added to your favorites.'
          : (notes.get(id) ?? 'Not on your schedule after the request.'),
      })),
      ...removes.map((id) => ({
        sessionId: id,
        code: codeOf(id),
        action: 'remove' as const,
        ok: !has(after, id),
        detail: !has(after, id)
          ? 'Removed from your schedule.'
          : (notes.get(id) ?? 'Still on your schedule.'),
      })),
    ];

    const local = loadLocal();
    local.accepted.push({
      proposalId: p.id,
      at: nowIso(),
      added: adds
        .filter((id) => has(after, id) && !has(before, id))
        .map((id) => ({
          sessionId: id,
          as: after.reserved.includes(id) ? 'reserved' : 'favorite',
        })),
      removed: removes
        .filter((id) => !has(after, id) && has(before, id))
        .map((id) => ({
          sessionId: id,
          was: before.reserved.includes(id) ? 'reserved' : 'favorite',
        })),
    });
    saveLocal(local);
    await this.publishManifest(after);
    return { results, state: this.state() };
  }

  /** Declining writes holds (ADR-013) so no agent proposes the same thing again. */
  async decline(proposalId: string): Promise<AgentState> {
    const { p } = this.findMine(proposalId);
    const local = loadLocal();
    const at = nowIso();
    const holds = local.holds.filter(
      (h) => !(p.add ?? []).includes(h.sessionId) && !(p.remove ?? []).includes(h.sessionId),
    );
    for (const id of p.add ?? []) holds.push({ sessionId: id, reason: 'declined', at });
    for (const id of p.remove ?? []) holds.push({ sessionId: id, reason: 'pinned', at });
    saveLocal({ ...local, holds });
    if (this.tokens.signedIn()) await this.publishManifest(await this.api.getSchedule(EVENT_ID));
    return this.state();
  }

  async undo(proposalId: string): Promise<{ results: SessionResult[]; state: AgentState }> {
    const local = loadLocal();
    const entry = [...local.accepted]
      .reverse()
      .find((a) => a.proposalId === proposalId || a.proposalId.startsWith(proposalId));
    if (!entry) throw new Error('Nothing to undo for that proposal on this machine.');
    const snap = this.requireSnapshot();
    const codeOf = (id: string) =>
      snap.snapshot.sessions.find((s) => s.sessionId === id)?.code ?? id;
    const notes = new Map<string, string>();
    const restoreFav = entry.removed.filter((r) => r.was === 'favorite').map((r) => r.sessionId);
    const restoreRes = entry.removed.filter((r) => r.was === 'reserved').map((r) => r.sessionId);
    try {
      if (restoreFav.length)
        for (const f of (await this.api.associateFavorites(EVENT_ID, restoreFav)).failed)
          notes.set(f.sessionId, failureText(f.code));
      if (restoreRes.length)
        for (const f of (await this.api.reserveSessions(EVENT_ID, restoreRes)).failed)
          notes.set(f.sessionId, failureText(f.code));
    } catch (e) {
      for (const id of [...restoreFav, ...restoreRes]) notes.set(id, errorText(e));
    }
    for (const a of entry.added) {
      try {
        if (a.as === 'reserved') await this.api.cancelReservation(EVENT_ID, a.sessionId);
        else await this.api.disassociateFavorite(EVENT_ID, a.sessionId);
      } catch (e) {
        notes.set(a.sessionId, errorText(e));
      }
    }
    const after = await this.api.getSchedule(EVENT_ID);
    const has = (id: string) => after.reserved.includes(id) || after.favorites.includes(id);
    const results: SessionResult[] = [
      ...entry.removed.map((r) => ({
        sessionId: r.sessionId,
        code: codeOf(r.sessionId),
        action: 'add' as const,
        ok: has(r.sessionId),
        detail: has(r.sessionId)
          ? 'Back on your schedule.'
          : (notes.get(r.sessionId) ?? 'Could not restore it.'),
      })),
      ...entry.added.map((a) => ({
        sessionId: a.sessionId,
        code: codeOf(a.sessionId),
        action: 'remove' as const,
        ok: !has(a.sessionId),
        detail: !has(a.sessionId)
          ? 'Removed again.'
          : (notes.get(a.sessionId) ?? 'Still on your schedule.'),
      })),
    ];
    saveLocal({
      ...loadLocal(),
      accepted: loadLocal().accepted.filter(
        (a) => a !== entry && a.proposalId !== entry.proposalId,
      ),
    });
    await this.publishManifest(after);
    return { results, state: this.state() };
  }

  setShare(level: LocalSquad['share']): void {
    saveLocal({ ...loadLocal(), share: level });
  }

  setPriority(sessionId: string, priority: number): void {
    const local = loadLocal();
    saveLocal({ ...local, priorities: { ...local.priorities, [sessionId]: priority } });
  }

  // -- Meeting points: personal time Junction owns (rule 8) ------------------------------------

  meetTag(label: string): string {
    const charter = loadCharter();
    const squadId = charter?.squadId ?? 'sq_solo';
    const squad8 = squadId.replace(/^sq_/, '').slice(0, 8);
    return `[jn1:meet:${squad8}:${sha256Hex(`meet|${squadId}|${label}`).slice(0, 6)}]`;
  }

  async listOwnPersonalTime(): Promise<PersonalTime[]> {
    const s = await this.api.getSchedule(EVENT_ID);
    return s.personalTime.filter((p) => JUNCTION_TAG.test(p.description));
  }

  /**
   * Creates a tagged meeting point. Reads the schedule first and skips if the tag exists; reads it
   * again after, since create returns no id and has no idempotency key (rule 4).
   */
  async createMeet(input: {
    label: string;
    date: string;
    start: string;
    end: string;
    location?: string;
    note?: string;
  }): Promise<{ created: boolean; entry: PersonalTime | undefined }> {
    const tag = this.meetTag(input.label);
    const existing = (await this.api.getSchedule(EVENT_ID)).personalTime.find((p) =>
      p.description.startsWith(tag),
    );
    if (existing) return { created: false, entry: existing };
    const body = personalTimeBody(tag, input);
    try {
      await this.api.createPersonalTime(EVENT_ID, body);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'unknown-outcome')) throw e;
    }
    const entry = (await this.api.getSchedule(EVENT_ID)).personalTime.find((p) =>
      p.description.startsWith(tag),
    );
    return { created: entry !== undefined, entry };
  }

  async moveMeet(
    personalTimeId: string,
    input: {
      label: string;
      date: string;
      start: string;
      end: string;
      location?: string;
      note?: string;
    },
  ): Promise<PersonalTime | undefined> {
    const own = (await this.listOwnPersonalTime()).find((p) => p.personalTimeId === personalTimeId);
    if (!own)
      throw new Error(
        'Junction only changes personal time it created. That entry is not one of them.',
      );
    const tag = own.description.slice(0, own.description.indexOf(']') + 1);
    await this.api.updatePersonalTime(EVENT_ID, personalTimeId, personalTimeBody(tag, input));
    return (await this.listOwnPersonalTime()).find((p) => p.personalTimeId === personalTimeId);
  }

  async deleteMeet(personalTimeId: string): Promise<boolean> {
    const own = (await this.listOwnPersonalTime()).find((p) => p.personalTimeId === personalTimeId);
    if (!own)
      throw new Error(
        'Junction only deletes personal time it created. That entry is not one of them.',
      );
    await this.api.deletePersonalTime(EVENT_ID, personalTimeId);
    return !(await this.listOwnPersonalTime()).some((p) => p.personalTimeId === personalTimeId);
  }
}

export const JUNCTION_TAG = /^\[jn1:(meet|walk|buf):[a-z2-7_]{1,8}:[0-9a-f]{6}\]/;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Event-local wall-clock times, 5-minute steps, same date (OpenAPI PersonalTimeInput). */
export function personalTimeBody(
  tag: string,
  input: {
    label: string;
    date: string;
    start: string;
    end: string;
    location?: string;
    note?: string;
  },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Use a date like 2026-12-01.');
  for (const t of [input.start, input.end]) {
    const m = CLOCK.exec(t);
    if (!m) throw new Error(`Use 24-hour times like 12:30 (got "${t}").`);
    if (Number(m[2]) % 5 !== 0) throw new Error(`Times must be on 5-minute steps (got "${t}").`);
  }
  if (input.end <= input.start) throw new Error('The end must be after the start.');
  const description = `${tag} ${input.note ?? 'Squad meeting point, set by Junction.'}`.slice(
    0,
    250,
  );
  return {
    startDateTime: `${input.date}T${input.start}:00`,
    endDateTime: `${input.date}T${input.end}:00`,
    title: input.label.slice(0, 128),
    description,
    ...(input.location ? { location: input.location.slice(0, 255) } : {}),
  };
}

function failureText(code: string, conflicts?: string[]): string {
  switch (code) {
    case 'sessionFull':
      return 'Full. Try its repeat or keep it as a favorite.';
    case 'scheduleConflict':
      return `Clashes with ${conflicts?.join(', ') ?? 'another session'} on your schedule.`;
    case 'alreadyScheduled':
    case 'alreadyFavorited':
      return 'Already on your schedule.';
    case 'sessionNotReservable':
      return 'This session takes no reservations. Added nothing.';
    case 'timePassed':
      return 'This session has already started.';
    case 'insufficientAccess':
      return 'Your pass does not include this session.';
    case 'notFavorited':
      return 'It was not a favorite.';
    default:
      return 'Refused by the API.';
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Unexpected failure.';
}
