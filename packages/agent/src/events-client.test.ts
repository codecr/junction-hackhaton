import { describe, expect, it } from 'vitest';
import { ApiError, EventsClient } from './events-client';
import { Pacer, type Clock } from './pacer';

function fakeClock(): Clock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
}

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

function scripted(replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(r.status === 204 ? null : text, {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function client(replies: Reply[]) {
  const clock = fakeClock();
  const { fetchFn, calls } = scripted(replies);
  const tokens: boolean[] = [];
  const c = new EventsClient({
    fetch: fetchFn,
    clock,
    pacer: new Pacer(clock),
    getToken: async (force) => {
      tokens.push(force === true);
      return 'tok';
    },
  });
  return { c, calls, clock, tokens };
}

describe('EventsClient', () => {
  it('paginates until nextToken is absent, even after a short page', async () => {
    const { c, calls } = client([
      {
        status: 200,
        body: { items: [{ sessionId: 'a' }, { sessionId: 'b' }], totalCount: 4, nextToken: 't1' },
      },
      { status: 200, body: { items: [{ sessionId: 'c' }], totalCount: 4, nextToken: 't2' } },
      { status: 200, body: { items: [{ sessionId: 'd' }], totalCount: 4 } },
    ]);
    const r = await c.listAllSessions('reinvent2026');
    expect(r.items.map((x) => x.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.pages).toBe(3);
    expect(calls[0]!.url).toContain('includeAbstracts=false');
    expect(calls[1]!.url).toContain('nextToken=t1');
  });

  it('waits Retry-After on 429 and retries', async () => {
    const { c, clock } = client([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '7' } },
      { status: 200, body: { schedule: { reserved: [], favorites: ['x'], personalTime: [] } } },
    ]);
    const s = await c.getSchedule('reinvent2026');
    expect(s.favorites).toEqual(['x']);
    expect(clock.slept).toContain(7000);
  });

  it('reports 409 as a closed operation, not a bug', async () => {
    const { c } = client([{ status: 409, body: { message: 'Reservations open later' } }]);
    await expect(c.reserveSessions('reinvent2026', ['a'])).rejects.toMatchObject({
      code: 'closed',
    });
  });

  it('reports partial failure per session and splits batches of more than 10', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const { c, calls } = client([
      {
        status: 200,
        body: {
          result: {
            successful: ids.slice(0, 8),
            failed: [
              { sessionId: 's8', code: 'sessionFull' },
              { sessionId: 's9', code: 'brandNewCode' },
            ],
          },
        },
      },
      { status: 200, body: { result: { successful: ['s10', 's11'], failed: [] } } },
    ]);
    const r = await c.reserveSessions('reinvent2026', ids);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]!.init?.body)).sessionIds).toHaveLength(10);
    expect(r.successful).toHaveLength(10);
    expect(r.failed.map((f) => f.code)).toEqual(['sessionFull', 'brandNewCode']);
  });

  it('never assumes JSON: an HTML 403 from the edge is an edge refusal', async () => {
    const { c } = client([{ status: 403, text: '<html>blocked</html>' }]);
    await expect(c.getSchedule('reinvent2026')).rejects.toMatchObject({ code: 'edge-refused' });
  });

  it('a JSON 403 means signed in but not registered', async () => {
    const { c } = client([{ status: 403, body: { message: 'not registered' } }]);
    await expect(c.getSchedule('reinvent2026')).rejects.toMatchObject({ code: 'not-registered' });
  });

  it('refreshes the token once on 401', async () => {
    const { c, tokens } = client([
      { status: 401, body: { message: 'expired' } },
      { status: 200, body: { schedule: { reserved: [], favorites: [], personalTime: [] } } },
    ]);
    await c.getSchedule('reinvent2026');
    expect(tokens).toContain(true);
  });

  it('never retries a write after a 5xx: the outcome is unknown', async () => {
    const { c, calls } = client([{ status: 502, text: 'bad gateway' }]);
    await expect(
      c.createPersonalTime('reinvent2026', {
        startDateTime: '2026-12-01T12:00:00',
        endDateTime: '2026-12-01T12:30:00',
        title: 't',
        description: 'd',
      }),
    ).rejects.toMatchObject({ code: 'unknown-outcome' });
    expect(calls).toHaveLength(1);
  });

  it('retries a read once after a 5xx', async () => {
    const { c, calls } = client([
      { status: 503, text: '' },
      { status: 200, body: { items: [{ eventId: 'reinvent2026' }] } },
    ]);
    await c.listEvents();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init?.headers).not.toHaveProperty('authorization');
  });

  it('sends the bearer token only to the API', async () => {
    const { c, calls } = client([
      { status: 200, body: { schedule: { reserved: [], favorites: [], personalTime: [] } } },
    ]);
    await c.getSchedule('reinvent2026');
    expect(calls[0]!.url.startsWith('https://api.awsevents.com/v1/')).toBe(true);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('rejects a response in an unexpected shape', async () => {
    const { c } = client([{ status: 200, body: { nope: true } }]);
    await expect(c.getSchedule('reinvent2026')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('Pacer', () => {
  it('spends one token per session and waits when the minute is used up', async () => {
    const clock = fakeClock();
    const p = new Pacer(clock);
    await p.acquire('ReserveSessions', 30);
    expect(clock.slept).toEqual([]);
    await p.acquire('ReserveSessions', 10);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(19_000);
  });
});
