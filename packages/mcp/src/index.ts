#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { SquadView } from '@junction/core';
import { Junction } from '@junction/agent';

// Local MCP server (spec J1). It reads the squad view built on this machine and acts only on the
// signed-in member's own schedule. It complements the official awsevents MCP server rather than
// wrapping it, and never exposes another member's data above the sharing level they chose (picks
// carry only session ids and codes; titles come from this member's own catalog).

export const packageName = '@junction/mcp';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function pickDay(view: SquadView, day: string | undefined): number | undefined {
  if (!day) return undefined;
  const d = day.trim().toLowerCase();
  const hit = view.days.find(
    (x) =>
      DAYS[x.weekday]!.toLowerCase() === d.slice(0, 3) ||
      `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}` === d ||
      String(x.d) === d,
  );
  if (!hit)
    throw new Error(
      `No squad day matches "${day}". Use Mon to Fri, a date like 2026-12-01, or the day of the month.`,
    );
  return hit.day;
}

const name = (v: SquadView, id: string) => v.members.find((m) => m.memberId === id)?.name ?? id;
const dayLabel = (v: SquadView, day: number | undefined) => {
  const d = v.days.find((x) => x.day === day);
  return d ? `${DAYS[d.weekday]} ${d.d}` : 'unknown day';
};
const sessionLabel = (v: SquadView, id: string) => {
  const s = v.sessions[id];
  if (!s) return id;
  const venue = v.venues.find((x) => x.id === s.venue)?.name ?? s.venue;
  return `${s.code} "${s.title}" (${dayLabel(v, s.day)} ${hhmm(s.startLocal)} to ${hhmm(s.endLocal)}, ${venue})`;
};

function text(t: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: t }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function createServer(app = new Junction()): McpServer {
  const server = new McpServer({ name: 'junction', version: '0.1.0' });

  const view = (): SquadView => {
    const v = app.view();
    if (!v)
      throw new Error(
        'No squad view on this machine yet. Run `junction squad create` or import a squad block, then `junction sync`.',
      );
    return v;
  };

  server.registerTool(
    'squad_coverage',
    {
      title: 'Squad coverage',
      description:
        'Which squad topics are covered on each re:Invent day, by whom, against the squad target.',
      inputSchema: {
        day: z
          .string()
          .optional()
          .describe('Mon to Fri, a date like 2026-12-01, or omit for the week'),
      },
    },
    async ({ day }) => {
      const v = view();
      const d = pickDay(v, day);
      const cells = v.coverage.cells.filter((c) => d === undefined || c.day === d);
      const lines = cells.map((c) => {
        const t = v.topics.find((x) => x.id === c.topicId)?.label ?? c.topicId;
        const who = c.members.map((m) => name(v, m)).join(', ') || 'nobody';
        return `${dayLabel(v, c.day)}, ${t}: ${c.count} of ${c.target} (${c.state === 'ok' ? 'covered' : c.state === 'under' ? 'under target' : 'nobody'}), ${who}`;
      });
      return text(lines.join('\n') || 'The squad has no topics yet.', { cells });
    },
  );

  server.registerTool(
    'squad_gaps',
    {
      title: 'Squad gaps',
      description:
        'Must-cover sessions nobody holds, topics under target, duplicates and walks a member cannot make.',
      inputSchema: { day: z.string().optional() },
    },
    async ({ day }) => {
      const v = view();
      const d = pickDay(v, day);
      const on = (x: number | undefined) => d === undefined || x === d;
      const out: string[] = [];
      for (const g of v.coverage.gaps.filter((x) => on(x.day)))
        out.push(
          `Nobody covers ${sessionLabel(v, g.sessionId)}${g.collidesWithLunch ? ', during the protected squad lunch' : ''}.`,
        );
      for (const c of v.coverage.cells.filter(
        (x) => on(x.day) && x.state !== 'ok' && x.offered > 0,
      ))
        out.push(
          `${v.topics.find((t) => t.id === c.topicId)?.label ?? c.topicId} on ${dayLabel(v, c.day)}: ${c.count} of ${c.target}.`,
        );
      for (const x of v.coverage.duplicates.filter((y) => on(y.day) && !y.planned))
        out.push(
          `Duplicate: ${x.attendees.map((a) => name(v, a)).join(' and ')} all hold ${sessionLabel(v, x.sessionId)}.`,
        );
      for (const h of v.coverage.hops.filter((y) => on(y.day)))
        out.push(
          `Can't make the walk: ${name(v, h.memberId)} to ${sessionLabel(v, h.toSessionId)} needs ${h.needMin} min, has ${h.haveMin}.`,
        );
      return text(out.join('\n') || 'No gaps.', {
        gaps: v.coverage.gaps,
        hops: v.coverage.hops,
        duplicates: v.coverage.duplicates,
      });
    },
  );

  server.registerTool(
    'squad_proposals',
    {
      title: 'Squad proposals',
      description:
        'Proposals the deterministic solver computed for the squad (identical on every member machine). Defaults to the signed-in member.',
      inputSchema: {
        all: z.boolean().optional().describe('true for every member, default only mine'),
      },
    },
    async ({ all }) => {
      const v = view();
      const list = all ? v.proposals : v.proposals.filter((p) => p.memberId === v.me);
      const lines = list.map((p) => {
        const add = (p.add ?? []).map((id) => sessionLabel(v, id)).join(', ');
        const rem = (p.remove ?? []).map((id) => sessionLabel(v, id)).join(', ');
        const what =
          p.kind === 'SWAP'
            ? `move from ${rem} to ${add}`
            : p.kind === 'CLAIM'
              ? `take ${add}`
              : p.kind === 'DROP'
                ? `release ${rem}`
                : 'meet';
        return `[${p.id.slice(0, 10)}] ${name(v, p.memberId)}: ${what}. Squad gain ${p.squadDelta}, personal ${p.personalDelta}. Reasons: ${p.reasons.join(', ')}${p.differences?.length ? `. The repeat differs in ${p.differences.join(', ')}` : ''}${p.provisional ? '. Provisional: catalogs differ.' : ''}`;
      });
      return text(lines.join('\n') || 'No proposals.', { proposals: list });
    },
  );

  server.registerTool(
    'squad_accept',
    {
      title: 'Accept a proposal',
      description:
        "Applies one of the signed-in member's own proposals to their re:Invent schedule (favorites), confirms from GetSchedule and returns per-session results. Refuses without confirm: true.",
      inputSchema: { proposalId: z.string().min(6), confirm: z.boolean() },
      annotations: { destructiveHint: true },
    },
    async ({ proposalId, confirm }) => {
      if (confirm !== true)
        return text('Not applied. Ask the member, then call again with confirm: true.');
      const { results } = await app.accept(proposalId);
      return text(
        results
          .map((r) => `${r.ok ? 'ok' : 'failed'}: ${r.action} ${r.code}. ${r.detail}`)
          .join('\n'),
        { results },
      );
    },
  );

  server.registerTool(
    'squad_sync',
    {
      title: 'Sync my picks',
      description:
        'Reads my schedule from the AWS Events API, signs my picks and recomputes the squad view.',
      inputSchema: {},
    },
    async () => {
      const s = await app.sync();
      return text(
        s.squad ? `Synced. ${s.squad.proposals.length} proposals for the squad.` : 'Synced.',
      );
    },
  );

  return server;
}

const isMain =
  process.argv[1] && /packages[\\/]mcp[\\/]src[\\/]index\.ts$|junction-mcp/.test(process.argv[1]);
if (isMain) {
  const server = createServer();
  server.connect(new StdioServerTransport()).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : 'MCP server failed'}\n`);
    process.exitCode = 1;
  });
}
