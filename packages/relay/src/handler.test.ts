import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromUtf8, toBase64Url } from '@junction/core';
import { MAX_BODY_BYTES } from './handler';
import {
  INVITE_SECRET,
  charterFor,
  harness,
  member,
  signedCharter,
  signedClaim,
  signedManifest,
  signedSignal,
  type Harness,
} from './test-kit';

const ana = member('Ana', 11);
const luis = member('Luis', 12);
const mia = member('Mia', 13);
const eve = member('Eve', 14);
const squadId = charterFor([ana, luis]).squadId;
const base = `/v1/squads/${squadId}`;

async function withSquad(members = [ana, luis]): Promise<Harness> {
  const h = harness();
  const res = await h.send(ana, 'POST', '/v1/squads', signedCharter(members));
  expect(res.statusCode).toBe(201);
  return h;
}

describe('health and routing', () => {
  it('answers health without a signature', async () => {
    const h = harness();
    const res = await h.call({
      rawPath: '/v1/health',
      headers: {},
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(200);
    expect(h.logs).toEqual([{ route: 'GET /v1/health', status: 200 }]);
  });

  it('returns 404 for unknown paths and 405 for wrong methods', async () => {
    const h = harness();
    expect((await h.send(ana, 'GET', '/v1/nope')).statusCode).toBe(404);
    expect((await h.send(ana, 'PATCH', base)).statusCode).toBe(405);
  });

  it('rejects malformed squad and member ids', async () => {
    const h = await withSquad();
    expect((await h.send(ana, 'GET', '/v1/squads/not-a-squad')).statusCode).toBe(400);
    expect((await h.send(ana, 'DELETE', `${base}/members/bob`)).statusCode).toBe(400);
  });
});

describe('creating a squad', () => {
  it('stores the signed charter and returns it to members', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'GET', base);
    expect(res.statusCode).toBe(200);
    expect(res.json['charter']).toEqual(signedCharter([ana, luis]));
    expect(res.json['manifests']).toEqual([]);
  });

  it('stores nothing but the envelope and bookkeeping', async () => {
    const h = await withSquad();
    const item = h.store.squads.get(squadId)!.get('CHARTER')!;
    expect(Object.keys(item).sort()).toEqual(['env', 'mid', 'seq', 'sk', 'ttl']);
    expect(item.ttl).toBe(Date.UTC(2026, 11, 18) / 1000);
  });

  it('refuses a duplicate squad id with 409', async () => {
    const h = await withSquad();
    const res = await h.send(ana, 'POST', '/v1/squads', signedCharter([ana, luis]));
    expect(res.statusCode).toBe(409);
    expect(res.json['error']).toBe('squad-exists');
  });

  it('requires the request to be signed by the charter leader', async () => {
    const h = harness();
    const res = await h.send(luis, 'POST', '/v1/squads', signedCharter([ana, luis]));
    expect(res.statusCode).toBe(403);
  });

  it('rejects a tampered charter', async () => {
    const h = harness();
    const env = signedCharter([ana, luis]);
    const payload = JSON.parse(fromUtf8(fromBase64Url(env.payload))) as Record<string, unknown>;
    payload['name'] = 'Hijacked';
    const tampered = {
      ...env,
      payload: toBase64Url(new TextEncoder().encode(JSON.stringify(payload))),
    };
    const res = await h.send(ana, 'POST', '/v1/squads', tampered);
    expect(res.statusCode).toBe(400);
    expect(res.json['error']).toBe('bad-signature');
  });

  it('rejects an expired or very long-lived charter', async () => {
    const h = harness();
    const expired = await h.send(
      ana,
      'POST',
      '/v1/squads',
      signedCharter([ana], { expiresAt: '2026-11-05T00:00:00Z' }),
    );
    expect(expired.statusCode).toBe(400);
    expect(expired.json['error']).toBe('expired-charter');
    const long = await h.send(
      ana,
      'POST',
      '/v1/squads',
      signedCharter([ana], { expiresAt: '2029-01-01T00:00:00Z' }),
    );
    expect(long.statusCode).toBe(400);
  });

  it('rejects bad JSON', async () => {
    const h = harness();
    const res = await h.send(ana, 'POST', '/v1/squads', '{not json');
    expect(res.statusCode).toBe(400);
    expect(res.json['error']).toBe('bad-json');
  });
});

describe('request signatures', () => {
  it('rejects an unsigned request', async () => {
    const h = await withSquad();
    const res = await h.call({
      rawPath: base,
      headers: {},
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)['error']).toBe('unsigned');
  });

  it('refuses bearer tokens outright', async () => {
    const h = await withSquad();
    const res = await h.call({
      rawPath: base,
      headers: { authorization: 'Bearer eyJhbGciOi.secret.token' },
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)['error']).toBe('bearer-refused');
    expect(res.body).not.toContain('eyJhbGciOi');
  });

  it('rejects a stale timestamp', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'GET', base, undefined, { tsMs: h.clock.ms - 121_000 });
    expect(res.statusCode).toBe(401);
    expect(res.json['error']).toBe('stale');
  });

  it('rejects a replayed nonce', async () => {
    const h = await withSquad();
    const nonce = new Uint8Array(16).fill(42);
    expect((await h.send(luis, 'GET', base, undefined, { nonce })).statusCode).toBe(200);
    const again = await h.send(luis, 'GET', base, undefined, { nonce });
    expect(again.statusCode).toBe(401);
    expect(again.json['error']).toBe('replayed');
  });

  it('records nonces with a ten minute ttl', async () => {
    const h = await withSquad();
    const nonces = [...h.store.squads.get(squadId)!.values()].filter((i) =>
      i.sk.startsWith('NONCE#'),
    );
    expect(nonces).toHaveLength(1);
    expect(nonces[0]!.ttl).toBe(h.clock.ms / 1000 + 600);
  });

  it('rejects a non-member with 403', async () => {
    const h = await withSquad();
    const res = await h.send(eve, 'GET', base);
    expect(res.statusCode).toBe(403);
    expect(res.json['error']).toBe('not-a-member');
  });

  it('rejects a signature over a different body', async () => {
    const h = await withSquad();
    const res = await h.call({
      rawPath: `${base}/members/${luis.memberId}/manifest`,
      body: JSON.stringify(signedManifest(luis, squadId)),
      headers: {
        authorization: (await import('@junction/core')).signRequest(
          { method: 'PUT', path: `${base}/members/${luis.memberId}/manifest`, body: '{}' },
          luis.memberId,
          luis.keys.secretKey,
          h.clock.ms / 1000,
          new Uint8Array(16).fill(5),
        ),
      },
      requestContext: { http: { method: 'PUT' } },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)['error']).toBe('bad-signature');
  });

  it('caps the payload at 64 KB', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'POST', `${base}/signals`, 'x'.repeat(MAX_BODY_BYTES + 1));
    expect(res.statusCode).toBe(413);
  });

  it('decodes base64 bodies from API Gateway', async () => {
    const h = harness();
    const body = JSON.stringify(signedCharter([ana]));
    const { signRequest } = await import('@junction/core');
    const res = await h.call({
      rawPath: '/v1/squads',
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
      headers: {
        authorization: signRequest(
          { method: 'POST', path: '/v1/squads', body },
          ana.memberId,
          ana.keys.secretKey,
          h.clock.ms / 1000,
          new Uint8Array(16).fill(8),
        ),
      },
      requestContext: { http: { method: 'POST' } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('logs route, status and squad id only', async () => {
    const h = await withSquad();
    await h.send(luis, 'GET', base);
    for (const entry of h.logs) {
      expect(Object.keys(entry).every((k) => ['route', 'squadId', 'status'].includes(k))).toBe(
        true,
      );
    }
    expect(h.logs.at(-1)).toEqual({ route: 'GET /v1/squads/{id}', status: 200, squadId });
  });

  it('returns 404 for a squad that does not exist', async () => {
    const h = harness();
    expect((await h.send(ana, 'GET', base)).statusCode).toBe(404);
  });
});

describe('charter updates', () => {
  it('replaces the charter with a higher seq, leader only', async () => {
    const h = await withSquad();
    const next = signedCharter([ana, luis, mia], { seq: 2 });
    expect((await h.send(luis, 'PUT', `${base}/charter`, next)).statusCode).toBe(403);
    expect((await h.send(ana, 'PUT', `${base}/charter`, next)).statusCode).toBe(200);
    expect((await h.send(mia, 'GET', base)).statusCode).toBe(200);
  });

  it('rejects a stale charter with 409', async () => {
    const h = await withSquad();
    const res = await h.send(
      ana,
      'PUT',
      `${base}/charter`,
      signedCharter([ana, luis, mia], { seq: 1 }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json['storedSeq']).toBe(1);
  });

  it('drops a removed member and hides their manifest', async () => {
    const h = await withSquad([ana, luis, mia]);
    expect(
      (
        await h.send(
          mia,
          'PUT',
          `${base}/members/${mia.memberId}/manifest`,
          signedManifest(mia, squadId),
        )
      ).statusCode,
    ).toBe(200);
    await h.send(ana, 'PUT', `${base}/charter`, signedCharter([ana, luis], { seq: 2 }));
    expect((await h.send(mia, 'GET', base)).statusCode).toBe(403);
    const view = await h.send(luis, 'GET', base);
    expect(view.json['manifests']).toEqual([]);
  });
});

describe('manifests', () => {
  const path = (m: { memberId: string }) => `${base}/members/${m.memberId}/manifest`;

  it('stores a member manifest and returns the latest one per member', async () => {
    const h = await withSquad();
    expect((await h.send(luis, 'PUT', path(luis), signedManifest(luis, squadId))).statusCode).toBe(
      200,
    );
    const v2 = signedManifest(luis, squadId, { seq: 2 });
    expect((await h.send(luis, 'PUT', path(luis), v2)).statusCode).toBe(200);
    const res = await h.send(ana, 'GET', base);
    expect(res.json['manifests']).toEqual([v2]);
  });

  it('rejects a stale seq with 409', async () => {
    const h = await withSquad();
    await h.send(luis, 'PUT', path(luis), signedManifest(luis, squadId, { seq: 5 }));
    const res = await h.send(luis, 'PUT', path(luis), signedManifest(luis, squadId, { seq: 5 }));
    expect(res.statusCode).toBe(409);
    expect(res.json['storedSeq']).toBe(5);
  });

  it('rejects writing another member manifest', async () => {
    const h = await withSquad();
    const res = await h.send(ana, 'PUT', path(luis), signedManifest(luis, squadId));
    expect(res.statusCode).toBe(403);
  });

  it('rejects a manifest whose signer is not the path member', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'PUT', path(luis), signedManifest(ana, squadId));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a manifest signed by a non-member', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'PUT', path(luis), signedManifest(eve, squadId));
    expect(res.statusCode).toBe(403);
    expect(res.json['error']).toBe('unknown-signer');
  });

  it('rejects a manifest for another squad', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'PUT', path(luis), signedManifest(luis, 'sq_aaaaaaaaaaaaaaaa'));
    expect(res.statusCode).toBe(400);
    expect(res.json['error']).toBe('wrong-squad');
  });

  it('rejects a charter sent to the manifest route', async () => {
    const h = await withSquad();
    const res = await h.send(ana, 'PUT', path(ana), signedCharter([ana, luis], { seq: 2 }));
    expect(res.statusCode).toBe(400);
  });

  it('supports If-None-Match', async () => {
    const h = await withSquad();
    const first = await h.send(luis, 'GET', base);
    const etag = first.headers['etag']!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const same = await h.call({
      rawPath: base,
      headers: {},
      requestContext: { http: { method: 'GET' } },
    });
    expect(same.statusCode).toBe(401);
    const notModified = await h.send(luis, 'GET', base, undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    await h.send(luis, 'PUT', path(luis), signedManifest(luis, squadId));
    const changed = await h.send(luis, 'GET', base, undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(changed.statusCode).toBe(200);
  });
});

describe('claims', () => {
  it('lets the first claim win and returns the winner to the loser', async () => {
    const h = await withSquad();
    const [a, b] = await Promise.all([
      h.send(ana, 'POST', `${base}/claims`, signedClaim(ana, squadId, 's-new')),
      h.send(luis, 'POST', `${base}/claims`, signedClaim(luis, squadId, 's-new')),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(409);
    expect(b.json['winner']).toBe(ana.memberId);
    expect(b.json['error']).toBe('already-claimed');
  });

  it('is idempotent for the winner', async () => {
    const h = await withSquad();
    await h.send(ana, 'POST', `${base}/claims`, signedClaim(ana, squadId, 's-new'));
    const again = await h.send(ana, 'POST', `${base}/claims`, signedClaim(ana, squadId, 's-new'));
    expect(again.statusCode).toBe(200);
    expect(again.json['winner']).toBe(ana.memberId);
  });

  it('refuses a claim signed by someone other than the requester', async () => {
    const h = await withSquad();
    const res = await h.send(luis, 'POST', `${base}/claims`, signedClaim(ana, squadId, 's-new'));
    expect(res.statusCode).toBe(400);
  });
});

describe('announcements', () => {
  it('keeps the earliest announcement', async () => {
    const h = await withSquad();
    const first = await h.send(ana, 'POST', `${base}/announcements`, { sessionId: 's-new' });
    expect(first.statusCode).toBe(201);
    h.clock.ms += 60_000;
    const second = await h.send(luis, 'POST', `${base}/announcements`, { sessionId: 's-new' });
    expect(second.statusCode).toBe(200);
    expect(second.json).toMatchObject({
      memberId: ana.memberId,
      announcedAt: '2026-11-06T12:00:00.000Z',
      first: false,
    });
  });

  it('rejects extra fields', async () => {
    const h = await withSquad();
    const res = await h.send(ana, 'POST', `${base}/announcements`, {
      sessionId: 's-new',
      title: 'Secret',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('signals', () => {
  it('appends scout notes and pages them with a cursor', async () => {
    const h = await withSquad();
    const n1 = signedSignal(luis, squadId, 's-1', 'Bring a laptop.');
    expect((await h.send(luis, 'POST', `${base}/signals`, n1)).statusCode).toBe(201);
    h.clock.ms += 1000;
    const n2 = signedSignal(ana, squadId, 's-2', 'Full room.');
    await h.send(ana, 'POST', `${base}/signals`, n2);

    const all = await h.send(ana, 'GET', `${base}/signals`);
    const signals = all.json['signals'] as { envelope: unknown }[];
    expect(signals.map((s) => s.envelope)).toEqual([n1, n2]);

    const after = await h.send(ana, 'GET', `${base}/signals`, undefined, {
      query: { since: all.json['cursor'] as string },
    });
    expect(after.json['signals']).toEqual([]);

    const sinceFirst = await h.send(ana, 'GET', `${base}/signals`, undefined, {
      query: { since: '2026-11-06T12:00:00.500Z' },
    });
    expect((sinceFirst.json['signals'] as { envelope: unknown }[]).map((s) => s.envelope)).toEqual([
      n2,
    ]);
  });

  it('rejects a bad since value', async () => {
    const h = await withSquad();
    const res = await h.send(ana, 'GET', `${base}/signals`, undefined, {
      query: { since: 'yesterday' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('join requests', () => {
  const joinBody = (m: typeof mia, secret = INVITE_SECRET) => ({
    publicKey: toBase64Url(m.keys.publicKey),
    name: m.name,
    inviteSecret: secret,
  });

  it('accepts a request with the right invite secret and shows it to the leader', async () => {
    const h = await withSquad();
    const res = await h.send(mia, 'POST', `${base}/join-requests`, joinBody(mia));
    expect(res.statusCode).toBe(202);
    expect(res.json['memberId']).toBe(mia.memberId);
    const list = await h.send(ana, 'GET', `${base}/join-requests`);
    expect(list.json['requests']).toEqual([
      {
        memberId: mia.memberId,
        publicKey: toBase64Url(mia.keys.publicKey),
        name: 'Mia',
        requestedAt: '2026-11-06T12:00:00.000Z',
      },
    ]);
    const stored = h.store.squads.get(squadId)!.get(`JOIN#${mia.memberId}`)!;
    expect(JSON.stringify(stored)).not.toContain(INVITE_SECRET);
  });

  it('rejects a wrong invite secret', async () => {
    const h = await withSquad();
    const res = await h.send(
      mia,
      'POST',
      `${base}/join-requests`,
      joinBody(mia, 'wrong-secret-123'),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json['error']).toBe('bad-invite');
  });

  it('rejects a request signed by a key other than the one in the body', async () => {
    const h = await withSquad();
    const res = await h.send(eve, 'POST', `${base}/join-requests`, joinBody(mia));
    expect(res.statusCode).toBe(403);
  });

  it('only shows join requests to the leader and hides approved members', async () => {
    const h = await withSquad();
    await h.send(mia, 'POST', `${base}/join-requests`, joinBody(mia));
    expect((await h.send(luis, 'GET', `${base}/join-requests`)).statusCode).toBe(403);
    await h.send(ana, 'PUT', `${base}/charter`, signedCharter([ana, luis, mia], { seq: 2 }));
    const list = await h.send(ana, 'GET', `${base}/join-requests`);
    expect(list.json['requests']).toEqual([]);
  });

  it('rejects extra fields such as an email', async () => {
    const h = await withSquad();
    const res = await h.send(mia, 'POST', `${base}/join-requests`, {
      ...joinBody(mia),
      email: 'mia@example.com',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('leave and purge', () => {
  it('removes a member’s data when they leave', async () => {
    const h = await withSquad();
    await h.send(
      luis,
      'PUT',
      `${base}/members/${luis.memberId}/manifest`,
      signedManifest(luis, squadId),
    );
    await h.send(luis, 'POST', `${base}/signals`, signedSignal(luis, squadId, 's-1', 'ok'));
    await h.send(luis, 'POST', `${base}/claims`, signedClaim(luis, squadId, 's-9'));
    const res = await h.send(luis, 'DELETE', `${base}/members/${luis.memberId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json['removed']).toBe(3);
    const items = [...h.store.squads.get(squadId)!.values()].filter((i) => i.mid === luis.memberId);
    expect(items).toEqual([]);
  });

  it('lets the leader remove a member but not another member', async () => {
    const h = await withSquad([ana, luis, mia]);
    expect((await h.send(mia, 'DELETE', `${base}/members/${luis.memberId}`)).statusCode).toBe(403);
    expect((await h.send(ana, 'DELETE', `${base}/members/${luis.memberId}`)).statusCode).toBe(200);
  });

  it('purges the squad, leader only, and keeps nonces against replay', async () => {
    const h = await withSquad();
    await h.send(
      luis,
      'PUT',
      `${base}/members/${luis.memberId}/manifest`,
      signedManifest(luis, squadId),
    );
    expect((await h.send(luis, 'DELETE', base)).statusCode).toBe(403);
    expect((await h.send(ana, 'DELETE', base)).statusCode).toBe(200);
    const left = [...h.store.squads.get(squadId)!.values()];
    expect(left.every((i) => i.sk.startsWith('NONCE#'))).toBe(true);
    expect((await h.send(ana, 'GET', base)).statusCode).toBe(404);
  });
});
