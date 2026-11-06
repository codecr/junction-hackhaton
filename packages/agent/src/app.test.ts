import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Bytes, toBase64Url, utf8 } from '@junction/core';
import { Junction, JUNCTION_TAG, personalTimeBody } from './app';
import { paths, writeJson } from './paths';
import { exportPicksBlock, importBlock } from './squad';

// End to end against an in-memory Events API, with the fictional demo squad. We sign in as Ana.

const root = join(__dirname, '..', '..', '..', 'fixtures', 'demo');
const apiSessions = JSON.parse(readFileSync(join(root, 'sessions.api.json'), 'utf8')) as {
  sessionId: string;
}[];
const envelopes = JSON.parse(readFileSync(join(root, 'envelopes.json'), 'utf8')) as {
  charter: unknown;
  manifests: { kid: string }[];
};
const squad = JSON.parse(readFileSync(join(root, 'squad.json'), 'utf8')) as {
  members: { key: string; memberId: string }[];
  manifests: { memberId: string; sessions: { sessionId: string; status: string }[] }[];
};
const ana = squad.members.find((m) => m.key === 'ana')!;
const anaManifest = squad.manifests.find((m) => m.memberId === ana.memberId)!;

interface FakeState {
  reserved: Set<string>;
  favorites: Set<string>;
  personal: {
    personalTimeId: string;
    startDateTime: string;
    endDateTime: string;
    title: string;
    description: string;
    location?: string;
  }[];
  full: Set<string>;
  writes: string[];
}

function fakeApi(state: FakeState): typeof fetch {
  let nextId = 1;
  return (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    const p = url.pathname.replace('/v1/events/reinvent2026', '');
    if (method !== 'GET') state.writes.push(`${method} ${p}`);
    if (url.pathname === '/v1/events/reinvent2026' && method === 'GET')
      return json(200, {
        event: {
          eventId: 'reinvent2026',
          timezone: 'America/Los_Angeles',
          startDate: '2026-11-30T08:00:00-08:00',
        },
      });
    if (p === '/sessions') return json(200, { items: apiSessions, totalCount: apiSessions.length });
    if (p === '/schedule')
      return json(200, {
        schedule: {
          reserved: [...state.reserved],
          favorites: [...state.favorites],
          personalTime: state.personal,
        },
      });
    if (p === '/favorites' && method === 'POST') {
      const ids = (JSON.parse(String(init?.body)) as { sessionIds: string[] }).sessionIds;
      const failed = ids
        .filter((id) => state.full.has(id))
        .map((sessionId) => ({ sessionId, code: 'other' }));
      ids.filter((id) => !state.full.has(id)).forEach((id) => state.favorites.add(id));
      return json(200, { result: { successful: ids.filter((id) => !state.full.has(id)), failed } });
    }
    const fav = /^\/favorites\/(.+)$/.exec(p);
    if (fav && method === 'DELETE') {
      state.favorites.delete(decodeURIComponent(fav[1]!));
      return json(204);
    }
    if (p === '/reservations' && method === 'POST') {
      const ids = (JSON.parse(String(init?.body)) as { sessionIds: string[] }).sessionIds;
      ids.forEach((id) => state.reserved.add(id));
      return json(200, { result: { successful: ids, failed: [] } });
    }
    const res = /^\/reservations\/(.+)$/.exec(p);
    if (res && method === 'DELETE') {
      state.reserved.delete(decodeURIComponent(res[1]!));
      return json(204);
    }
    if (p === '/personal-time' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as FakeState['personal'][number];
      state.personal.push({ ...body, personalTimeId: `pt-${nextId++}` });
      return json(204);
    }
    const pt = /^\/personal-time\/(.+)$/.exec(p);
    if (pt && method === 'DELETE') {
      state.personal = state.personal.filter((x) => x.personalTimeId !== pt[1]);
      return json(204);
    }
    if (pt && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as FakeState['personal'][number];
      state.personal = state.personal.map((x) =>
        x.personalTimeId === pt[1] ? { ...body, personalTimeId: x.personalTimeId } : x,
      );
      return json(204);
    }
    return json(404, { message: `no route ${method} ${p}` });
  }) as unknown as typeof fetch;
}

let state: FakeState;
let app: Junction;

beforeEach(async () => {
  process.env.JUNCTION_HOME = mkdtempSync(join(tmpdir(), 'junction-'));
  const seed = sha256Bytes(utf8('junction-demo-key-v4:ana'));
  writeJson(paths.key(), { seed: toBase64Url(seed), name: 'Ana' });
  writeJson(paths.credentials(), {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: Date.now() + 3_600_000,
  });
  writeJson(paths.charter(), envelopes.charter);
  writeJson(paths.manifests(), Object.fromEntries(envelopes.manifests.map((e) => [e.kid, e])));
  state = {
    reserved: new Set(
      anaManifest.sessions.filter((s) => s.status === 'reserved').map((s) => s.sessionId),
    ),
    favorites: new Set(
      anaManifest.sessions.filter((s) => s.status !== 'reserved').map((s) => s.sessionId),
    ),
    personal: [],
    full: new Set(),
    writes: [],
  };
  app = new Junction({ fetch: fakeApi(state) });
  await app.refreshCatalog();
});

describe('Junction agent, end to end against a fake Events API', () => {
  it('signs picks from GetSchedule and finds the swap proposed to Ana', async () => {
    const s = await app.sync();
    expect(s.squad?.members.map((m) => m.name)).toContain('Ana');
    const mine = s.squad!.proposals.filter((p) => p.memberId === ana.memberId);
    expect(mine.map((p) => p.kind)).toEqual(['SWAP']);
  });

  it('accepts the swap: adds first, removes after, confirms from GetSchedule, then undoes it', async () => {
    const s = await app.sync();
    const swap = s.squad!.proposals.find((p) => p.memberId === ana.memberId)!;
    const { results, state: after } = await app.accept(swap.id);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(state.favorites.has(swap.add![0]!)).toBe(true);
    expect(state.reserved.has(swap.remove![0]!) || state.favorites.has(swap.remove![0]!)).toBe(
      false,
    );
    const addIdx = state.writes.findIndex((w) => w.startsWith('POST /favorites'));
    const removeIdx = state.writes.findIndex((w) => w.startsWith('DELETE'));
    expect(addIdx).toBeLessThan(removeIdx);
    expect(after.squad!.proposals.some((p) => p.id === swap.id)).toBe(false);

    const undone = await app.undo(swap.id);
    expect(undone.results.every((r) => r.ok)).toBe(true);
    expect(state.favorites.has(swap.add![0]!)).toBe(false);
  });

  it('keeps the old session when the new one cannot be added, and says so per session', async () => {
    const s = await app.sync();
    const swap = s.squad!.proposals.find((p) => p.memberId === ana.memberId)!;
    state.full.add(swap.add![0]!);
    const { results } = await app.accept(swap.id);
    expect(results.find((r) => r.action === 'add')!.ok).toBe(false);
    const removal = results.find((r) => r.action === 'remove')!;
    expect(removal.ok).toBe(false);
    expect(removal.detail).toMatch(/Kept/);
    expect(state.writes.some((w) => w.startsWith('DELETE'))).toBe(false);
  });

  it('declining writes holds, so the proposal is not made again', async () => {
    const s = await app.sync();
    const swap = s.squad!.proposals.find((p) => p.memberId === ana.memberId)!;
    const after = await app.decline(swap.id);
    expect(after.squad!.proposals.some((p) => p.memberId === ana.memberId)).toBe(false);
  });

  it('refuses a proposal meant for another member', async () => {
    const s = await app.sync();
    const other = s.squad!.proposals.find((p) => p.memberId !== ana.memberId)!;
    await expect(app.accept(other.id)).rejects.toThrow(/Only they can accept/);
  });

  it('creates a tagged meeting point once, and only touches its own entries', async () => {
    state.personal.push({
      personalTimeId: 'mine',
      startDateTime: '2026-12-01T09:00:00',
      endDateTime: '2026-12-01T10:00:00',
      title: 'Breakfast',
      description: 'my own',
    });
    const input = {
      label: 'Squad lunch',
      date: '2026-12-01',
      start: '12:30',
      end: '13:15',
      location: 'Venetian',
    };
    const first = await app.createMeet(input);
    const second = await app.createMeet(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(state.personal.filter((p) => JUNCTION_TAG.test(p.description))).toHaveLength(1);
    await expect(app.deleteMeet('mine')).rejects.toThrow(/only deletes personal time it created/);
    const moved = await app.moveMeet(first.entry!.personalTimeId, {
      ...input,
      start: '12:45',
      end: '13:30',
    });
    expect(moved?.startDateTime).toBe('2026-12-01T12:45:00');
    expect(await app.deleteMeet(first.entry!.personalTimeId)).toBe(true);
    expect(state.personal.map((p) => p.personalTimeId)).toEqual(['mine']);
  });

  it('exports and re-imports a squad block without losing anything', async () => {
    await app.sync();
    const block = exportPicksBlock();
    expect(block.startsWith('junction1:')).toBe(true);
    const decoded = Buffer.from(block.slice('junction1:'.length), 'base64url').toString('utf8');
    // Privacy: titles never travel.
    expect(decoded).not.toContain('Agent memory in production');
    const r = importBlock(block);
    expect(r.rejected).toEqual([]);
  });
});

describe('personal time body', () => {
  it('uses event-local wall clock, 5-minute steps, and keeps the tag inside 250 characters', () => {
    const b = personalTimeBody('jn1-meet-abcdefgh-0a1b2c', {
      label: 'x',
      date: '2026-12-01',
      start: '12:30',
      end: '13:00',
      note: 'y'.repeat(400),
    });
    expect(b.startDateTime).toBe('2026-12-01T12:30:00');
    expect(b.description.length).toBe(250);
    expect(() =>
      personalTimeBody('t', { label: 'x', date: '2026-12-01', start: '12:31', end: '13:00' }),
    ).toThrow(/5-minute/);
  });
});
