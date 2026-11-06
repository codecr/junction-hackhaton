import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sha256Bytes, toBase64Url, utf8 } from '@junction/core';
import { Junction, paths, writeJson } from '@junction/agent';
import { createServer } from './index';

// The MCP tools over the fictional demo squad, read from local state only (signed in as Ana).
const root = join(__dirname, '..', '..', '..', 'fixtures', 'demo');
const envelopes = JSON.parse(readFileSync(join(root, 'envelopes.json'), 'utf8')) as {
  charter: unknown;
  manifests: { kid: string }[];
};
const apiSessions = JSON.parse(readFileSync(join(root, 'sessions.api.json'), 'utf8')) as Record<
  string,
  unknown
>[];

let client: Client;

beforeAll(async () => {
  process.env.JUNCTION_HOME = mkdtempSync(join(tmpdir(), 'junction-mcp-'));
  writeJson(paths.key(), {
    seed: toBase64Url(sha256Bytes(utf8('junction-demo-key-v4:ana'))),
    name: 'Ana',
  });
  writeJson(paths.charter(), envelopes.charter);
  writeJson(paths.manifests(), Object.fromEntries(envelopes.manifests.map((e) => [e.kid, e])));
  const app = new Junction();
  app.store.saveRaw(
    {
      eventId: 'reinvent2026',
      timezone: 'America/Los_Angeles',
      utcOffsetMin: -480,
      fetchedAt: '2026-11-06T00:00:00Z',
      totalCount: apiSessions.length,
      pages: 1,
    },
    apiSessions,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(app).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

describe('junction MCP server', () => {
  it('lists the squad tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'squad_accept',
      'squad_coverage',
      'squad_gaps',
      'squad_proposals',
      'squad_sync',
    ]);
  });

  it('answers who covers what on Tuesday', async () => {
    const r = await client.callTool({ name: 'squad_coverage', arguments: { day: 'Tue' } });
    expect(textOf(r)).toMatch(/Tue 1/);
  });

  it('reports gaps with plain words', async () => {
    const r = await client.callTool({ name: 'squad_gaps', arguments: { day: 'Tue' } });
    expect(textOf(r)).toMatch(/Duplicate|Can't make the walk|Nobody covers/);
  });

  it('lists my proposal, the OPS305-R1 swap', async () => {
    const r = await client.callTool({ name: 'squad_proposals', arguments: {} });
    expect(textOf(r)).toMatch(/Ana: move from OPS305-R .* to OPS305-R1/);
  });

  it('refuses to accept without confirm: true', async () => {
    const r = await client.callTool({
      name: 'squad_accept',
      arguments: { proposalId: 'abcdef', confirm: false },
    });
    expect(textOf(r)).toMatch(/Not applied/);
  });
});
